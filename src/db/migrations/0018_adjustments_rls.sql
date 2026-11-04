-- Invoice adjustments: row-level security, privileges, and the rules that an
-- adjustment is decided once and that approved adjustments never exceed the
-- invoice's total (SCHEMA.md §7.5, M3).

ALTER TABLE "invoice_adjustments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoice_adjustments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invoice_adjustments"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

GRANT SELECT, INSERT ON "invoice_adjustments" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("status", "decided_by", "decided_at", "document_id") ON "invoice_adjustments" TO hospital_app;
--> statement-breakpoint

-- For every role, the owner included: an adjustment is written pending,
-- decided once, and never removed; what it asks for never changes. Approval
-- takes the invoice's lock and re-checks M3 in the database as well as the
-- service: the invoice is finalised, and its approved adjustments stay
-- within its total. Slice 5 adds allocations to that sum.
CREATE FUNCTION invoice_adjustments_lifecycle() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  invoice_total integer;
  invoice_status text;
  adjusted bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invoice adjustments are never removed'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'an adjustment is requested before it is decided'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'a decided adjustment cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.facility_id IS DISTINCT FROM OLD.facility_id
    OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
    OR NEW.reason IS DISTINCT FROM OLD.reason
    OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
    OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
  THEN
    RAISE EXCEPTION 'an adjustment is decided, never edited'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.status = 'approved' THEN
    SELECT "total_cents", "status" INTO invoice_total, invoice_status
      FROM "invoices"
      WHERE "facility_id" = NEW.facility_id AND "id" = NEW.invoice_id
      FOR UPDATE;
    IF invoice_status <> 'finalised' THEN
      RAISE EXCEPTION 'only a finalised invoice is adjusted'
        USING ERRCODE = 'restrict_violation';
    END IF;

    SELECT coalesce(sum("amount_cents"), 0) INTO adjusted
      FROM "invoice_adjustments"
      WHERE "facility_id" = NEW.facility_id AND "invoice_id" = NEW.invoice_id
        AND "status" = 'approved' AND "id" <> NEW.id;
    IF adjusted + NEW.amount_cents > invoice_total THEN
      RAISE EXCEPTION 'adjustments cannot exceed the invoice''s total'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER invoice_adjustments_lifecycle
  BEFORE INSERT OR UPDATE OR DELETE ON "invoice_adjustments"
  FOR EACH ROW EXECUTE FUNCTION invoice_adjustments_lifecycle();
