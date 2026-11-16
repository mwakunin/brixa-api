-- Follow-ups to 0090 (CodeRabbit's fourth round on #20), for every role.

-- An adjustment's lines are written with it, while it is pending: a line
-- added once it is decided would change its value with no movement.
CREATE FUNCTION stock_adjustment_lines_while_pending() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'an adjustment line is written once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "stock_adjustments" a WHERE a."id" = NEW."adjustment_id" AND a."status" = 'pending' FOR SHARE) THEN
    RAISE EXCEPTION 'adjustment % is decided: no line is added to it', NEW."adjustment_id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stock_adjustment_lines_while_pending
  BEFORE INSERT OR UPDATE OR DELETE ON "stock_adjustment_lines"
  FOR EACH ROW EXECUTE FUNCTION stock_adjustment_lines_while_pending();
--> statement-breakpoint

-- As in 0090, and each step changes only its own columns: the stores, the
-- number and the steps already taken stay as they were recorded.
CREATE OR REPLACE FUNCTION stock_transfers_forward() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  sending constant text[] := ARRAY['status', 'sent_by', 'sent_at'];
  closing constant text[] := ARRAY['status', 'closed_by', 'closed_at', 'close_reason'];
  receiving constant text[] := ARRAY['status', 'received_by', 'received_at', 'shortfall_reason'];
  acceptance constant text[] := ARRAY['shortfall_accepted_by', 'shortfall_accepted_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a transfer is closed, never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (OLD.status = 'requested' AND NEW.status IN ('requested', 'sent') AND (to_jsonb(NEW) - sending) = (to_jsonb(OLD) - sending))
    OR (OLD.status = 'requested' AND NEW.status IN ('cancelled', 'declined') AND (to_jsonb(NEW) - closing) = (to_jsonb(OLD) - closing))
    OR (OLD.status = 'sent' AND NEW.status IN ('sent', 'received') AND (to_jsonb(NEW) - receiving) = (to_jsonb(OLD) - receiving))
    OR (OLD.status = 'received' AND NEW.status = 'received' AND OLD.shortfall_accepted_by IS NULL
        AND (to_jsonb(NEW) - acceptance) = (to_jsonb(OLD) - acceptance)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'transfer % cannot change that way from %', OLD.id, OLD.status
    USING ERRCODE = 'restrict_violation';
END;
$$;
