-- A pending adjustment is decided before it can be reversed: approving it
-- and setting its reversal columns in one update would skip the approved
-- reversal request the later branch demands.
CREATE OR REPLACE FUNCTION invoice_adjustments_lifecycle() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  invoice_total integer;
  invoice_status text;
  used bigint;
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
    IF OLD.status = 'approved' AND OLD.reversed_at IS NULL AND NEW.reversed_at IS NOT NULL
      AND (to_jsonb(NEW) - 'reversed_at' - 'reversed_by' - 'reversal_reason')
        IS NOT DISTINCT FROM (to_jsonb(OLD) - 'reversed_at' - 'reversed_by' - 'reversal_reason')
    THEN
      IF NOT EXISTS (
        SELECT 1 FROM "adjustment_reversals" r
        WHERE r."facility_id" = NEW.facility_id AND r."adjustment_id" = NEW.id
          AND r."status" = 'approved' AND r."decided_by" = NEW.reversed_by
      ) THEN
        RAISE EXCEPTION 'an adjustment is reversed only by an approved reversal request'
          USING ERRCODE = 'restrict_violation';
      END IF;
      IF NEW.document_id IS NOT NULL THEN
        UPDATE "documents" SET "voided_at" = now(), "void_reason" = NEW.reversal_reason
          WHERE "facility_id" = NEW.facility_id AND "id" = NEW.document_id AND "voided_at" IS NULL;
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a decided adjustment cannot change, but for being reversed once'
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

  IF NEW.reversed_at IS NOT NULL OR NEW.reversed_by IS NOT NULL OR NEW.reversal_reason IS NOT NULL THEN
    RAISE EXCEPTION 'an adjustment is approved before it is reversed'
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

    SELECT
      (SELECT coalesce(sum("amount_cents"), 0)
         FROM "invoice_adjustments"
         WHERE "facility_id" = NEW.facility_id AND "invoice_id" = NEW.invoice_id
           AND "status" = 'approved' AND "reversed_at" IS NULL AND "id" <> NEW.id)
      + (SELECT coalesce(sum(a."amount_cents"), 0)
         FROM "allocations" a
         JOIN "payments" p ON p."facility_id" = a."facility_id" AND p."id" = a."payment_id"
         WHERE a."facility_id" = NEW.facility_id AND a."invoice_id" = NEW.invoice_id
           AND a."reversed_at" IS NULL AND p."reversed_at" IS NULL)
      INTO used;
    IF used + NEW.amount_cents > invoice_total THEN
      RAISE EXCEPTION 'adjustments and allocations cannot exceed the invoice''s total'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
