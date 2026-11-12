-- As in 0055, and an issued prescription takes no new medicine: its printed
-- paper is frozen with the medicines written alongside it.
CREATE OR REPLACE FUNCTION order_items_lifecycle() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  parent record;
  lifecycle constant text[] := ARRAY['status', 'done_at', 'done_by', 'cancelled_at', 'cancelled_by', 'cancellation_reason'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an order item is cancelled, never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'ordered' THEN
      RAISE EXCEPTION 'an order item is written ordered'
        USING ERRCODE = 'check_violation';
    END IF;
    -- A prescription's medicines are written in the transaction that wrote
    -- its order and issued its paper; afterwards the paper is frozen, and an
    -- item added later would be missing from it. The order row's xmin names
    -- the transaction that wrote it. (prescribe() writes the order at the top
    -- level of its transaction, never inside a savepoint.)
    SELECT o.document_id, o.xmin::text AS written_by INTO parent FROM orders o
      WHERE o.facility_id = NEW.facility_id AND o.id = NEW.order_id;
    IF parent.document_id IS NOT NULL AND parent.written_by::bigint <> (txid_current() & 4294967295) THEN
      RAISE EXCEPTION 'an issued prescription takes no new medicine; write a new prescription'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'ordered' THEN
    RAISE EXCEPTION 'a done or cancelled order item cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - lifecycle) IS DISTINCT FROM (to_jsonb(OLD) - lifecycle) THEN
    RAISE EXCEPTION 'what an order item asks for never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
