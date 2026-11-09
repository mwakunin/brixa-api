-- Reversing an approved adjustment: row-level security, privileges, the
-- request's lifecycle, and M3 counting only adjustments not reversed.

ALTER TABLE "adjustment_reversals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "adjustment_reversals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "adjustment_reversals"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

GRANT SELECT, INSERT ON "adjustment_reversals" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("status", "decided_by", "decided_at") ON "adjustment_reversals" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("reversed_at", "reversed_by", "reversal_reason") ON "invoice_adjustments" TO hospital_app;
--> statement-breakpoint

-- For every role, the owner included: written pending, decided once, what
-- was asked never changes, never removed.
CREATE FUNCTION adjustment_reversals_lifecycle() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reversal requests are never removed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'a reversal is requested before it is decided'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'a decided reversal request cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'decided_by' - 'decided_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'decided_by' - 'decided_at') THEN
    RAISE EXCEPTION 'a reversal request is decided, never edited'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER adjustment_reversals_lifecycle
  BEFORE INSERT OR UPDATE OR DELETE ON "adjustment_reversals"
  FOR EACH ROW EXECUTE FUNCTION adjustment_reversals_lifecycle();
--> statement-breakpoint

-- An approved adjustment may now be reversed, once, by setting only its
-- reversal columns; and M3 counts only adjustments not reversed.
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
--> statement-breakpoint

CREATE OR REPLACE FUNCTION allocations_within_limits() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  payment_amount integer;
  payment_reversed timestamptz;
  invoice_total integer;
  invoice_status text;
  used bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'allocations are never removed'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.reversed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a reversed allocation cannot change'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF (to_jsonb(NEW) - 'reversed_at' - 'reversed_by' - 'reversal_reason')
      IS DISTINCT FROM (to_jsonb(OLD) - 'reversed_at' - 'reversed_by' - 'reversal_reason')
    THEN
      RAISE EXCEPTION 'an allocation is reversed, never edited'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'an allocation is written standing'
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT "amount_cents", "reversed_at" INTO payment_amount, payment_reversed
    FROM "payments"
    WHERE "facility_id" = NEW.facility_id AND "id" = NEW.payment_id
    FOR UPDATE;
  IF payment_reversed IS NOT NULL THEN
    RAISE EXCEPTION 'a reversed payment settles nothing'
      USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT
    (SELECT coalesce(sum("amount_cents"), 0)
       FROM "allocations"
       WHERE "facility_id" = NEW.facility_id AND "payment_id" = NEW.payment_id AND "reversed_at" IS NULL)
    + (SELECT coalesce(sum("amount_cents"), 0)
       FROM "refunds"
       WHERE "facility_id" = NEW.facility_id AND "payment_id" = NEW.payment_id
         AND "status" = 'approved' AND "reversed_at" IS NULL)
    INTO used;
  IF used + NEW.amount_cents > payment_amount THEN
    RAISE EXCEPTION 'allocations and refunds cannot exceed their payment'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT "total_cents", "status" INTO invoice_total, invoice_status
    FROM "invoices"
    WHERE "facility_id" = NEW.facility_id AND "id" = NEW.invoice_id
    FOR UPDATE;
  IF invoice_status <> 'finalised' THEN
    RAISE EXCEPTION 'only a finalised invoice is settled'
      USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT
    (SELECT coalesce(sum(a."amount_cents"), 0)
       FROM "allocations" a
       JOIN "payments" p ON p."facility_id" = a."facility_id" AND p."id" = a."payment_id"
       WHERE a."facility_id" = NEW.facility_id AND a."invoice_id" = NEW.invoice_id
         AND a."reversed_at" IS NULL AND p."reversed_at" IS NULL)
    + (SELECT coalesce(sum("amount_cents"), 0)
       FROM "invoice_adjustments"
       WHERE "facility_id" = NEW.facility_id AND "invoice_id" = NEW.invoice_id
         AND "status" = 'approved' AND "reversed_at" IS NULL)
    INTO used;
  IF used + NEW.amount_cents > invoice_total THEN
    RAISE EXCEPTION 'allocations and adjustments cannot exceed the invoice''s total'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
