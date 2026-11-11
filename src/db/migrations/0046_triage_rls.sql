-- Triage: row-level security, privileges and triggers for vital signs and
-- allergies, and the triage priority in a queue entry's lifecycle.

ALTER TABLE "observations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "observations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "observations"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

ALTER TABLE "patient_allergies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "patient_allergies" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "patient_allergies"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

-- A reading is marked entered in error, never edited or removed.
GRANT SELECT, INSERT ON "observations" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("entered_in_error_at", "entered_in_error_by", "entered_in_error_reason") ON "observations" TO hospital_app;
--> statement-breakpoint

-- An allergy is ended, never edited or removed.
GRANT SELECT, INSERT ON "patient_allergies" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("removed_at", "removed_by", "removal_reason") ON "patient_allergies" TO hospital_app;
--> statement-breakpoint

-- For every role, the owner included: a reading changes only by being marked
-- entered in error, once, and is never deleted.
CREATE FUNCTION observations_error_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a reading is marked entered in error, never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.entered_in_error_at IS NOT NULL THEN
    RAISE EXCEPTION 'a reading marked entered in error cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.facility_id IS DISTINCT FROM OLD.facility_id
    OR NEW.encounter_id IS DISTINCT FROM OLD.encounter_id
    OR NEW.code IS DISTINCT FROM OLD.code
    OR NEW.value IS DISTINCT FROM OLD.value
    OR NEW.observed_at IS DISTINCT FROM OLD.observed_at
    OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
    OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
  THEN
    RAISE EXCEPTION 'a reading is marked entered in error, never edited'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER observations_error_only
  BEFORE UPDATE OR DELETE ON "observations"
  FOR EACH ROW EXECUTE FUNCTION observations_error_only();
--> statement-breakpoint

-- Likewise an allergy: ended once, never edited, never deleted.
CREATE FUNCTION patient_allergies_end_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an allergy is ended, never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'an ended allergy cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.facility_id IS DISTINCT FROM OLD.facility_id
    OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
    OR NEW.category IS DISTINCT FROM OLD.category
    OR NEW.allergen IS DISTINCT FROM OLD.allergen
    OR NEW.reaction IS DISTINCT FROM OLD.reaction
    OR NEW.severity IS DISTINCT FROM OLD.severity
    OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
    OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
  THEN
    RAISE EXCEPTION 'an allergy is ended, never edited'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER patient_allergies_end_only
  BEFORE UPDATE OR DELETE ON "patient_allergies"
  FOR EACH ROW EXECUTE FUNCTION patient_allergies_end_only();
--> statement-breakpoint

-- As in 0042, with the triage priority: an entry is inserted without one,
-- and gets one only as a triage entry finishes (serving -> done). After that
-- it is frozen with the rest of the ended entry.
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
    IF NEW.status <> 'waiting' OR NEW.priority IS NOT NULL THEN
      RAISE EXCEPTION 'a queue entry starts waiting, with no priority'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT status, kind INTO visit FROM encounters
      WHERE facility_id = NEW.facility_id AND id = NEW.encounter_id;
    IF visit.status IS DISTINCT FROM 'open' OR visit.kind NOT IN ('opd', 'emergency') THEN
      RAISE EXCEPTION 'only an open outpatient visit or emergency attendance joins a queue'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT is_active INTO point FROM service_points
      WHERE facility_id = NEW.facility_id AND id = NEW.service_point_id;
    IF point.is_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'that service point is out of use'
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
    OR NEW.joined_at <> OLD.joined_at OR NEW.joined_by <> OLD.joined_by THEN
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
  IF NEW.priority IS NOT NULL THEN
    SELECT kind INTO point FROM service_points
      WHERE facility_id = NEW.facility_id AND id = NEW.service_point_id;
    IF point.kind IS DISTINCT FROM 'triage' THEN
      RAISE EXCEPTION 'only triage sets a priority'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- The priority is part of a queue entry's lifecycle, set by the app as triage finishes.
GRANT UPDATE ("priority") ON "queue_entries" TO hospital_app;
