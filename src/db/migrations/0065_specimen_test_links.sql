-- A result is for a test its specimen was taken for: the pair is one of the
-- specimen's links, not merely a specimen and an order item of the facility.
-- The key comes first, since the foreign key needs it.
ALTER TABLE "specimen_tests" ADD CONSTRAINT "specimen_tests_facility_specimen_item_key" UNIQUE("facility_id","specimen_id","order_item_id");--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_specimen_test_fk" FOREIGN KEY ("facility_id","specimen_id","order_item_id") REFERENCES "public"."specimen_tests"("facility_id","specimen_id","order_item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- As in 0057, and the links are now what a result stands on, so: a test is
-- linked only to a specimen of the type it was ordered with (0060), and only
-- in the transaction that takes the specimen. A link added later would name a
-- test that was never taken with the sample. For every role, the owner
-- included.
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
  SELECT order_id, specimen_type, status, collected_at, received_at, xmin::text AS written_by INTO specimen FROM specimens
    WHERE facility_id = NEW.facility_id AND id = NEW.specimen_id;
  IF item.lab_test_id IS NULL OR item.order_id IS DISTINCT FROM specimen.order_id THEN
    RAISE EXCEPTION 'a specimen is for lab tests on its own order'
      USING ERRCODE = 'check_violation';
  END IF;
  IF item.specimen_type IS DISTINCT FROM specimen.specimen_type THEN
    RAISE EXCEPTION 'a specimen is for tests ordered on its specimen type'
      USING ERRCODE = 'check_violation';
  END IF;
  -- The specimen row's xmin names the transaction that last wrote it. Only
  -- taking it writes it collected, or received at the moment it was taken
  -- (by the lab); receiving it later or rejecting it writes it otherwise, and
  -- nothing else changes it (specimens_lifecycle). (writeSpecimen() writes it
  -- at the top level of its transaction, never inside a savepoint.)
  IF specimen.written_by::bigint <> (txid_current() & 4294967295)
    OR specimen.status = 'rejected'
    OR (specimen.received_at IS NOT NULL AND specimen.received_at <> specimen.collected_at) THEN
    RAISE EXCEPTION 'a specimen''s tests are written as it is taken'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
