-- Results back to the clinician (decided 2026-11-17, ROADMAP.md P3): the
-- queue entry's two new facts held for every role, the review table's
-- row-level security and privileges, and the audit actions.

-- As in 0046, with the return. An entry starts not to come back; it is told
-- to come back only as a clinic finishes with the patient (serving -> done).
-- An entry that is a return says so from its start, at a clinic, for good.
CREATE OR REPLACE FUNCTION queue_entries_lifecycle() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  visit record;
  point record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a queue entry is ended, never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'waiting' OR NEW.priority IS NOT NULL OR NEW.come_back_with_results THEN
      RAISE EXCEPTION 'a queue entry starts waiting, with no priority, not yet told to come back'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT status, kind INTO visit FROM encounters
      WHERE facility_id = NEW.facility_id AND id = NEW.encounter_id;
    IF visit.status IS DISTINCT FROM 'open' OR visit.kind NOT IN ('opd', 'emergency') THEN
      RAISE EXCEPTION 'only an open outpatient visit or emergency attendance joins a queue'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT is_active, kind INTO point FROM service_points
      WHERE facility_id = NEW.facility_id AND id = NEW.service_point_id;
    IF point.is_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'that service point is out of use'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.returned_with_results AND point.kind IS DISTINCT FROM 'consultation' THEN
      RAISE EXCEPTION 'only a clinic takes a patient back with results'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('done', 'left', 'cancelled') THEN
    RAISE EXCEPTION 'an ended queue entry cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.facility_id <> OLD.facility_id OR NEW.encounter_id <> OLD.encounter_id
    OR NEW.service_point_id <> OLD.service_point_id
    OR NEW.joined_at <> OLD.joined_at OR NEW.joined_by <> OLD.joined_by
    OR NEW.returned_with_results <> OLD.returned_with_results THEN
    RAISE EXCEPTION 'what a queue entry was never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT ((OLD.status = 'waiting' AND NEW.status IN ('serving', 'left', 'cancelled'))
    OR (OLD.status = 'serving' AND NEW.status = 'done')) THEN
    RAISE EXCEPTION 'a queue entry cannot go from % to %', OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'serving'
    AND (NEW.serving_at IS DISTINCT FROM OLD.serving_at OR NEW.served_by IS DISTINCT FROM OLD.served_by) THEN
    RAISE EXCEPTION 'who served the patient, and when, never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.priority IS NOT NULL OR NEW.come_back_with_results THEN
    SELECT kind INTO point FROM service_points
      WHERE facility_id = NEW.facility_id AND id = NEW.service_point_id;
    IF NEW.priority IS NOT NULL AND point.kind IS DISTINCT FROM 'triage' THEN
      RAISE EXCEPTION 'only triage sets a priority'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.come_back_with_results AND point.kind IS DISTINCT FROM 'consultation' THEN
      RAISE EXCEPTION 'only a clinic asks a patient to come back with results'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- Told as the clinic finishes with the patient.
GRANT UPDATE ("come_back_with_results") ON "queue_entries" TO hospital_app;
--> statement-breakpoint

ALTER TABLE "lab_result_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "lab_result_reviews" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "lab_result_reviews"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint
GRANT SELECT, INSERT ON "lab_result_reviews" TO hospital_app;
--> statement-breakpoint

-- A review is of a result the clinician could read (released or verified),
-- and stands: never changed or removed, by any role.
CREATE FUNCTION lab_result_reviews_append_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'a result''s review stands: it is never changed or removed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "lab_results" r
    WHERE r."facility_id" = NEW."facility_id" AND r."id" = NEW."lab_result_id" AND r."status" IN ('released', 'verified')
  ) THEN
    RAISE EXCEPTION 'only a released or verified result is reviewed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER lab_result_reviews_append_only
  BEFORE INSERT OR UPDATE OR DELETE ON "lab_result_reviews"
  FOR EACH ROW EXECUTE FUNCTION lab_result_reviews_append_only();
--> statement-breakpoint

INSERT INTO "audit_actions" ("action") VALUES
  ('lab_result.reviewed'),
  ('lab_result.review_list_viewed');
