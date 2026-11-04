-- Accounts and invoices: row-level security, privileges, the invoice
-- lifecycle, and the rules that a finalised invoice never changes and that a
-- charge is never assigned beyond its amount (SCHEMA.md §7.3, M4).

ALTER TABLE "payers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payers"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "accounts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "accounts"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invoices"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

ALTER TABLE "invoice_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoice_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invoice_lines"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

ALTER TABLE "charge_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "charge_assignments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "charge_assignments"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

-- Payers are created with P7's payer module; in P2 the app only reads them.
GRANT SELECT ON "payers" TO hospital_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "accounts", "invoice_lines", "charge_assignments" TO hospital_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "invoices" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("status", "total_cents", "document_id", "finalised_at", "finalised_by", "voided_at", "voided_by", "void_reason")
  ON "invoices" TO hospital_app;
--> statement-breakpoint

-- For every role, the owner included: an invoice moves draft → finalised,
-- draft → void or finalised → void, and nothing else about it changes. A
-- finalised invoice keeps its total and document when voided, so the voided
-- copy still says what was billed. The lifecycle CHECK shapes the columns
-- of each state; this trigger orders the states.
CREATE FUNCTION invoices_lifecycle() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.status = 'void' THEN
    RAISE EXCEPTION 'a voided invoice cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.facility_id IS DISTINCT FROM OLD.facility_id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.encounter_id IS DISTINCT FROM OLD.encounter_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'an invoice''s account, encounter and kind never change'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status = 'draft' AND NEW.status NOT IN ('finalised', 'void') THEN
    RAISE EXCEPTION 'a draft invoice is finalised or voided'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status = 'finalised' AND (
    NEW.status <> 'void'
    OR NEW.total_cents IS DISTINCT FROM OLD.total_cents
    OR NEW.document_id IS DISTINCT FROM OLD.document_id
    OR NEW.finalised_at IS DISTINCT FROM OLD.finalised_at
    OR NEW.finalised_by IS DISTINCT FROM OLD.finalised_by
  ) THEN
    RAISE EXCEPTION 'a finalised invoice can only be voided'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER invoices_lifecycle
  BEFORE UPDATE ON "invoices"
  FOR EACH ROW EXECUTE FUNCTION invoices_lifecycle();
--> statement-breakpoint

-- Lines and assignments are written while their invoice is a draft, and
-- never changed or removed (rule 19). The share lock on the invoice makes a
-- concurrent finalisation wait for this insert, or this insert see it.
CREATE FUNCTION invoice_lines_draft_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'invoice lines are never changed or removed'
      USING ERRCODE = 'restrict_violation';
  END IF;

  PERFORM 1 FROM "invoices"
    WHERE "facility_id" = NEW.facility_id AND "id" = NEW.invoice_id AND "status" = 'draft'
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lines are added to a draft invoice only'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER invoice_lines_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON "invoice_lines"
  FOR EACH ROW EXECUTE FUNCTION invoice_lines_draft_only();
--> statement-breakpoint

-- M4 in the database as well as the service: an assignment goes on a draft
-- invoice, to a charge that stands, and the charge's live assignments never
-- exceed its amount. Locking the charge serialises two assignments of it;
-- the service already holds that lock (lock order M8), so this costs nothing.
CREATE FUNCTION charge_assignments_within_charge() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  charge_amount integer;
  charge_cancelled timestamptz;
  assigned bigint;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'charge assignments are never changed or removed'
      USING ERRCODE = 'restrict_violation';
  END IF;

  PERFORM 1 FROM "invoice_lines" l
    JOIN "invoices" i ON i."facility_id" = l."facility_id" AND i."id" = l."invoice_id"
    WHERE l."facility_id" = NEW.facility_id AND l."id" = NEW.invoice_line_id AND i."status" = 'draft'
    FOR SHARE OF i;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'charges are assigned on a draft invoice only'
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT "amount_cents", "cancelled_at" INTO charge_amount, charge_cancelled
    FROM "charges"
    WHERE "facility_id" = NEW.facility_id AND "id" = NEW.charge_id
    FOR UPDATE;
  IF charge_cancelled IS NOT NULL THEN
    RAISE EXCEPTION 'a cancelled charge cannot be billed'
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT coalesce(sum(a."amount_cents"), 0) INTO assigned
    FROM "charge_assignments" a
    JOIN "invoice_lines" l ON l."facility_id" = a."facility_id" AND l."id" = a."invoice_line_id"
    JOIN "invoices" i ON i."facility_id" = l."facility_id" AND i."id" = l."invoice_id"
    WHERE a."facility_id" = NEW.facility_id AND a."charge_id" = NEW.charge_id AND i."status" <> 'void';
  IF assigned + NEW.amount_cents > charge_amount THEN
    RAISE EXCEPTION 'a charge cannot be billed beyond its amount'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER charge_assignments_within_charge
  BEFORE INSERT OR UPDATE OR DELETE ON "charge_assignments"
  FOR EACH ROW EXECUTE FUNCTION charge_assignments_within_charge();
--> statement-breakpoint

-- Fiscal series for facilities onboarded before they existed, as onboarding
-- now registers them: yearly, six digits (INV-2026-000123). Each counter is
-- created on first use.
INSERT INTO "number_series" ("facility_id", "kind", "prefix", "padding", "reset_period")
SELECT f."id", s."kind", s."prefix", 6, 'yearly'
FROM "facilities" f
CROSS JOIN (VALUES ('receipt', 'RCT-'), ('invoice', 'INV-'), ('credit_note', 'CN-')) AS s("kind", "prefix")
ON CONFLICT ("facility_id", "kind") DO NOTHING;
