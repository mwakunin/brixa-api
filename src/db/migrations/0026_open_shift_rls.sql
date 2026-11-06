-- Money goes through a shift only while it is open. A closed shift has been
-- counted, and its totals must not change afterwards. For every role, the
-- owner included: a payment taken, or a refund paid out, names an open
-- shift, held with a share lock so a close waits for it (closing takes the
-- shift's update lock).
CREATE FUNCTION require_open_shift(p_facility_id uuid, p_shift_id uuid) RETURNS void
  LANGUAGE plpgsql
  AS $$
DECLARE
  closed timestamptz;
BEGIN
  IF p_shift_id IS NULL THEN
    RETURN;
  END IF;
  SELECT "closed_at" INTO closed
    FROM "cashier_shifts"
    WHERE "facility_id" = p_facility_id AND "id" = p_shift_id
    FOR SHARE;
  IF closed IS NOT NULL THEN
    RAISE EXCEPTION 'money goes through a shift only while it is open'
      USING ERRCODE = 'restrict_violation';
  END IF;
END;
$$;
--> statement-breakpoint

CREATE FUNCTION payments_on_open_shift() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  PERFORM require_open_shift(NEW.facility_id, NEW.cashier_shift_id);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payments_on_open_shift
  BEFORE INSERT ON "payments"
  FOR EACH ROW EXECUTE FUNCTION payments_on_open_shift();
--> statement-breakpoint

CREATE FUNCTION refunds_paid_on_open_shift() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.paid_at IS NULL AND NEW.paid_at IS NOT NULL THEN
    PERFORM require_open_shift(NEW.facility_id, NEW.cashier_shift_id);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER refunds_paid_on_open_shift
  BEFORE UPDATE ON "refunds"
  FOR EACH ROW EXECUTE FUNCTION refunds_paid_on_open_shift();
