-- Review fixes for P2 (PR #7).

-- Finalising re-checks what it freezes, for every role: the total is the sum
-- of the lines, and each itemised line asks for exactly what its charge
-- assignments do. Otherwise a hand-written line could bill one amount while
-- the charge counted another as billed.
CREATE OR REPLACE FUNCTION invoices_lifecycle() RETURNS trigger
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

  IF OLD.status = 'draft' AND NEW.status = 'finalised' THEN
    IF NEW.total_cents IS DISTINCT FROM (
      SELECT coalesce(sum("amount_cents"), 0) FROM "invoice_lines"
      WHERE "facility_id" = NEW.facility_id AND "invoice_id" = NEW.id
    ) THEN
      RAISE EXCEPTION 'an invoice''s total is the sum of its lines'
        USING ERRCODE = 'check_violation';
    END IF;

    IF EXISTS (
      SELECT 1 FROM "invoice_lines" l
      WHERE l."facility_id" = NEW.facility_id AND l."invoice_id" = NEW.id AND l."kind" = 'itemised'
        AND l."amount_cents" IS DISTINCT FROM (
          SELECT coalesce(sum(a."amount_cents"), 0) FROM "charge_assignments" a
          WHERE a."facility_id" = l."facility_id" AND a."invoice_line_id" = l."id"
        )
    ) THEN
      RAISE EXCEPTION 'an itemised line asks for what its charges are assigned'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- A bed-day run marks a failure resolved once the nights it named are charged.
GRANT UPDATE ("resolved_at") ON "job_failures" TO hospital_app;
