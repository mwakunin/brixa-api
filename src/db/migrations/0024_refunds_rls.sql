-- Refunds: row-level security, privileges, the lifecycle (asked, decided
-- once, paid out once, reversed once), and M2 counting refunds beside
-- allocations: Σ live allocations + Σ live refunds ≤ the payment. A refund
-- is live from approval until it is reversed.

ALTER TABLE "refunds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "refunds" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "refunds"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

GRANT SELECT, INSERT ON "refunds" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE (
  "status", "decided_by", "decided_at",
  "paid_at", "paid_by", "method", "reference", "cashier_shift_id", "document_id",
  "reversed_at", "reversed_by", "reversal_reason"
) ON "refunds" TO hospital_app;
--> statement-breakpoint

-- For every role, the owner included. What was asked never changes. A
-- pending refund is decided once; approving it locks its payment and checks
-- M2. An approved refund is paid out once and reversed once, and a reversed,
-- rejected or withdrawn one never changes again.
CREATE FUNCTION refunds_lifecycle() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  payment_amount integer;
  payment_reversed timestamptz;
  used bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'refunds are never removed'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'a refund is requested before it is decided'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - 'status' - 'decided_by' - 'decided_at'
        - 'paid_at' - 'paid_by' - 'method' - 'reference' - 'cashier_shift_id' - 'document_id'
        - 'reversed_at' - 'reversed_by' - 'reversal_reason')
    IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'decided_by' - 'decided_at'
        - 'paid_at' - 'paid_by' - 'method' - 'reference' - 'cashier_shift_id' - 'document_id'
        - 'reversed_at' - 'reversed_by' - 'reversal_reason')
  THEN
    RAISE EXCEPTION 'what a refund asks for never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status IN ('rejected', 'withdrawn') OR OLD.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a closed refund cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status = 'pending' THEN
    IF NEW.paid_at IS NOT NULL OR NEW.reversed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a refund is approved before it is paid out or reversed'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.status = 'approved' THEN
      SELECT "amount_cents", "reversed_at" INTO payment_amount, payment_reversed
        FROM "payments"
        WHERE "facility_id" = NEW.facility_id AND "id" = NEW.payment_id
        FOR UPDATE;
      IF payment_reversed IS NOT NULL THEN
        RAISE EXCEPTION 'a reversed payment refunds nothing'
          USING ERRCODE = 'restrict_violation';
      END IF;
      SELECT
        (SELECT coalesce(sum("amount_cents"), 0)
           FROM "allocations"
           WHERE "facility_id" = NEW.facility_id AND "payment_id" = NEW.payment_id AND "reversed_at" IS NULL)
        + (SELECT coalesce(sum("amount_cents"), 0)
           FROM "refunds"
           WHERE "facility_id" = NEW.facility_id AND "payment_id" = NEW.payment_id
             AND "status" = 'approved' AND "reversed_at" IS NULL AND "id" <> NEW.id)
        INTO used;
      IF used + NEW.amount_cents > payment_amount THEN
        RAISE EXCEPTION 'allocations and refunds cannot exceed their payment'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- Approved: the decision stands, and a payout once recorded never changes.
  IF (NEW.status, NEW.decided_by, NEW.decided_at) IS DISTINCT FROM (OLD.status, OLD.decided_by, OLD.decided_at) THEN
    RAISE EXCEPTION 'an approved refund stays approved'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.paid_at IS NOT NULL
    AND (NEW.paid_at, NEW.paid_by, NEW.method, NEW.reference, NEW.cashier_shift_id, NEW.document_id)
      IS DISTINCT FROM (OLD.paid_at, OLD.paid_by, OLD.method, OLD.reference, OLD.cashier_shift_id, OLD.document_id)
  THEN
    RAISE EXCEPTION 'a refund is paid out once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER refunds_lifecycle
  BEFORE INSERT OR UPDATE OR DELETE ON "refunds"
  FOR EACH ROW EXECUTE FUNCTION refunds_lifecycle();
--> statement-breakpoint

-- M2 from the allocation's side now counts live refunds as well.
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

-- A payment with a refund standing cannot be reversed: the money already
-- went back, or is promised back. Reverse the refund first.
CREATE OR REPLACE FUNCTION payments_reverse_only() RETURNS trigger
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
  IF NEW.reversed_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM "refunds"
    WHERE "facility_id" = NEW.facility_id AND "payment_id" = NEW.id
      AND "status" = 'approved' AND "reversed_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'a payment with a refund standing cannot be reversed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- The refund series for facilities onboarded before it existed, as
-- onboarding now registers it: yearly, six digits (RFD-2026-000001).
INSERT INTO "number_series" ("facility_id", "kind", "prefix", "padding", "reset_period")
SELECT f."id", 'refund', 'RFD-', 6, 'yearly'
FROM "facilities" f
ON CONFLICT ("facility_id", "kind") DO NOTHING;
