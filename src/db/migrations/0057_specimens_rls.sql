-- Specimens: row-level security, privileges, the accession series, and a
-- specimen's lifecycle, held for every role.

ALTER TABLE "specimens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "specimens" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "specimens"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint
ALTER TABLE "specimen_tests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "specimen_tests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "specimen_tests"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

-- A specimen is received or rejected; which tests it is for is written once.
GRANT SELECT, INSERT ON "specimens" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("status", "received_at", "received_by", "rejected_at", "rejected_by", "rejection_reason", "rejection_note")
  ON "specimens" TO hospital_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "specimen_tests" TO hospital_app;
--> statement-breakpoint

-- The accession series for facilities onboarded before it existed, as
-- onboarding now registers it: daily, three digits (L-20261111-001).
INSERT INTO "number_series" ("facility_id", "kind", "prefix", "padding", "reset_period")
SELECT f."id", 'lab_accession', 'L-', 3, 'daily'
FROM "facilities" f
ON CONFLICT ("facility_id", "kind") DO NOTHING;
--> statement-breakpoint

-- For every role, the owner included: a specimen is written collected (or
-- received, when the lab took it); collected moves to received or rejected,
-- received to rejected; a rejected specimen never changes; what it is, whose
-- and when it was taken never change; nothing is deleted.
CREATE FUNCTION specimens_lifecycle() RETURNS trigger
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
CREATE TRIGGER specimens_lifecycle
  BEFORE INSERT OR UPDATE OR DELETE ON "specimens"
  FOR EACH ROW EXECUTE FUNCTION specimens_lifecycle();
--> statement-breakpoint

-- For every role: a specimen's tests are lab tests on its own order, written
-- with it and never changed or deleted.
CREATE FUNCTION specimen_tests_written_once() RETURNS trigger
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
  SELECT order_id, lab_test_id INTO item FROM order_items
    WHERE facility_id = NEW.facility_id AND id = NEW.order_item_id;
  SELECT order_id INTO specimen FROM specimens
    WHERE facility_id = NEW.facility_id AND id = NEW.specimen_id;
  IF item.lab_test_id IS NULL OR item.order_id IS DISTINCT FROM specimen.order_id THEN
    RAISE EXCEPTION 'a specimen is for lab tests on its own order'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER specimen_tests_written_once
  BEFORE INSERT OR UPDATE OR DELETE ON "specimen_tests"
  FOR EACH ROW EXECUTE FUNCTION specimen_tests_written_once();
