-- Pharmacy and stores' lifecycles held in the database for every role, the
-- owner included, as price changes' are (0012): the services check the
-- same, but a hand-run correction or a bug must not undo a decision whose
-- stock has moved or whose patient was credited (CodeRabbit on #20).

-- A stock adjustment is decided once: its approval moved stock.
CREATE FUNCTION stock_adjustments_decided_once() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'a decided stock adjustment cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stock_adjustments_decided_once
  BEFORE UPDATE OR DELETE ON "stock_adjustments"
  FOR EACH ROW EXECUTE FUNCTION stock_adjustments_decided_once();
--> statement-breakpoint

-- A patient's return is decided once: a done one credited the patient.
CREATE FUNCTION dispense_returns_decided_once() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'a decided return cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER dispense_returns_decided_once
  BEFORE UPDATE OR DELETE ON "dispense_returns"
  FOR EACH ROW EXECUTE FUNCTION dispense_returns_decided_once();
--> statement-breakpoint

-- A dispense handed over or cancelled is final (SCHEMA.md §10).
CREATE FUNCTION dispenses_final() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'prepared' THEN
    RAISE EXCEPTION 'a dispense handed over or cancelled cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER dispenses_final
  BEFORE UPDATE OR DELETE ON "dispenses"
  FOR EACH ROW EXECUTE FUNCTION dispenses_final();
--> statement-breakpoint

-- A transfer only moves forward: a request is sent, cancelled or declined;
-- stock sent is received. Once received, only a shortfall's acceptance is
-- written, once; a closed request never changes.
CREATE FUNCTION stock_transfers_forward() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  acceptance constant text[] := ARRAY['shortfall_accepted_by', 'shortfall_accepted_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a transfer is closed, never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (OLD.status = 'requested' AND NEW.status IN ('requested', 'sent', 'cancelled', 'declined'))
    OR (OLD.status = 'sent' AND NEW.status IN ('sent', 'received'))
    OR (OLD.status = 'received' AND NEW.status = 'received' AND OLD.shortfall_accepted_by IS NULL
        AND (to_jsonb(NEW) - acceptance) = (to_jsonb(OLD) - acceptance)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a transfer % cannot go from % to %', OLD.id, OLD.status, NEW.status
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stock_transfers_forward
  BEFORE UPDATE OR DELETE ON "stock_transfers"
  FOR EACH ROW EXECUTE FUNCTION stock_transfers_forward();
