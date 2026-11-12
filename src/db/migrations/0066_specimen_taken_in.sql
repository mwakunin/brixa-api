-- Which transaction took a specimen, for its links (0065) to tell creation
-- apart from a later write: a row's xmin names whichever transaction last
-- wrote it, so a later update, even one that changes nothing, would pass for
-- the taking one. The column is set by the database as the row is written
-- (whatever the insert says) and, not being a lifecycle column, never changes
-- (specimens_lifecycle). Rows already taken get this migration's
-- transaction, so none takes a new link afterwards.
ALTER TABLE "specimens" ADD COLUMN "taken_in_xact" bigint DEFAULT txid_current() NOT NULL;--> statement-breakpoint

-- As in 0057, and an inserted specimen is stamped with its transaction.
CREATE OR REPLACE FUNCTION specimens_lifecycle() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  lifecycle constant text[] := ARRAY['status', 'received_at', 'received_by', 'rejected_at', 'rejected_by', 'rejection_reason', 'rejection_note'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a specimen is rejected, never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'rejected' THEN
      RAISE EXCEPTION 'a specimen is written collected or received'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.taken_in_xact := txid_current();
    RETURN NEW;
  END IF;

  IF OLD.status = 'rejected' THEN
    RAISE EXCEPTION 'a rejected specimen cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'collected' AND NEW.status IN ('received', 'rejected'))
    OR (OLD.status = 'received' AND NEW.status = 'rejected')
  ) THEN
    RAISE EXCEPTION 'a specimen moves collected -> received -> rejected, never back'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.received_at IS NOT NULL
    AND (NEW.received_at IS DISTINCT FROM OLD.received_at OR NEW.received_by IS DISTINCT FROM OLD.received_by) THEN
    RAISE EXCEPTION 'a specimen is received once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - lifecycle) IS DISTINCT FROM (to_jsonb(OLD) - lifecycle) THEN
    RAISE EXCEPTION 'what a specimen is, whose, and when it was taken never change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- As in 0065, with the taking transaction read from the specimen's stamp
-- rather than its xmin.
CREATE OR REPLACE FUNCTION specimen_tests_written_once() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  item record;
  specimen record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'which tests a specimen is for is written once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT order_id, lab_test_id, specimen_type INTO item FROM order_items
    WHERE facility_id = NEW.facility_id AND id = NEW.order_item_id;
  SELECT order_id, specimen_type, taken_in_xact INTO specimen FROM specimens
    WHERE facility_id = NEW.facility_id AND id = NEW.specimen_id;
  IF item.lab_test_id IS NULL OR item.order_id IS DISTINCT FROM specimen.order_id THEN
    RAISE EXCEPTION 'a specimen is for lab tests on its own order'
      USING ERRCODE = 'check_violation';
  END IF;
  IF item.specimen_type IS DISTINCT FROM specimen.specimen_type THEN
    RAISE EXCEPTION 'a specimen is for tests ordered on its specimen type'
      USING ERRCODE = 'check_violation';
  END IF;
  IF specimen.taken_in_xact IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'a specimen''s tests are written as it is taken'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- As in 0061, and a value is for an analyte of its result's own test: one
-- from another test would print under this one on the report.
CREATE OR REPLACE FUNCTION lab_result_values_while_entered() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  parent record;
BEGIN
  SELECT r.status, i.lab_test_id INTO parent FROM lab_results r
    JOIN order_items i ON i.facility_id = r.facility_id AND i.id = r.order_item_id
    WHERE r.facility_id = NEW.facility_id AND r.id = NEW.result_id
    FOR SHARE OF r;
  IF parent.status IS DISTINCT FROM 'entered' THEN
    RAISE EXCEPTION 'a result''s values are written while it is entered'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM lab_analytes a
    WHERE a.facility_id = NEW.facility_id AND a.id = NEW.analyte_id AND a.lab_test_id = parent.lab_test_id) THEN
    RAISE EXCEPTION 'a result''s values are for analytes of its own test'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
