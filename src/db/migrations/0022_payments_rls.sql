-- Shifts, payments and allocations: row-level security, privileges, and
-- the rules that money rows change only by reversal and that allocations
-- never exceed their payment (M2) or, with adjustments, their invoice (M3).

ALTER TABLE "cashier_shifts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cashier_shifts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "cashier_shifts"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payments"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

ALTER TABLE "allocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "allocations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "allocations"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

GRANT SELECT, INSERT ON "cashier_shifts", "payments", "allocations" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("closed_at", "declared_cash_cents") ON "cashier_shifts" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("reversed_at", "reversed_by", "reversal_reason") ON "payments", "allocations" TO hospital_app;
--> statement-breakpoint

-- For every role, the owner included: a shift is closed once, and nothing
-- else about it changes. Its totals are derived from its payments.
CREATE FUNCTION cashier_shifts_close_once() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cashier shifts are never removed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a closed shift cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.facility_id IS DISTINCT FROM OLD.facility_id
    OR NEW.cashier_id IS DISTINCT FROM OLD.cashier_id
    OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
    OR NEW.opening_float_cents IS DISTINCT FROM OLD.opening_float_cents
  THEN
    RAISE EXCEPTION 'a shift is closed, never edited'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cashier_shifts_close_once
  BEFORE UPDATE OR DELETE ON "cashier_shifts"
  FOR EACH ROW EXECUTE FUNCTION cashier_shifts_close_once();
--> statement-breakpoint

-- Payments and allocations change only by being reversed, once (§10).
CREATE FUNCTION payments_reverse_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payments are never removed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a reversed payment cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - 'reversed_at' - 'reversed_by' - 'reversal_reason')
    IS DISTINCT FROM (to_jsonb(OLD) - 'reversed_at' - 'reversed_by' - 'reversal_reason')
  THEN
    RAISE EXCEPTION 'a payment is reversed, never edited'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payments_reverse_only
  BEFORE UPDATE OR DELETE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION payments_reverse_only();
--> statement-breakpoint

-- An allocation goes from a standing payment to a finalised invoice of the
-- same account (the foreign keys see to that), within what is left of both.
-- The payment's lock, then the invoice's (lock order M8); the service holds
-- them already. "Live" is derived: neither the allocation nor its payment is
-- reversed. Slice 5b adds refunds to the payment's side.
CREATE FUNCTION allocations_within_limits() RETURNS trigger
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
  SELECT coalesce(sum("amount_cents"), 0) INTO used
    FROM "allocations"
    WHERE "facility_id" = NEW.facility_id AND "payment_id" = NEW.payment_id AND "reversed_at" IS NULL;
  IF used + NEW.amount_cents > payment_amount THEN
    RAISE EXCEPTION 'allocations cannot exceed their payment'
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
       WHERE "facility_id" = NEW.facility_id AND "invoice_id" = NEW.invoice_id AND "status" = 'approved')
    INTO used;
  IF used + NEW.amount_cents > invoice_total THEN
    RAISE EXCEPTION 'allocations and adjustments cannot exceed the invoice''s total'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER allocations_within_limits
  BEFORE INSERT OR UPDATE OR DELETE ON "allocations"
  FOR EACH ROW EXECUTE FUNCTION allocations_within_limits();
--> statement-breakpoint

-- M3 from the adjustment's side now counts live allocations as well.
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

    SELECT
      (SELECT coalesce(sum("amount_cents"), 0)
         FROM "invoice_adjustments"
         WHERE "facility_id" = NEW.facility_id AND "invoice_id" = NEW.invoice_id
           AND "status" = 'approved' AND "id" <> NEW.id)
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
