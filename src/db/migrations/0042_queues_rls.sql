-- Service points and queues: row-level security, privileges, and a queue
-- entry's lifecycle, held for every role.

ALTER TABLE "service_points" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "service_points" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "service_points"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

ALTER TABLE "queue_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "queue_entries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "queue_entries"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

-- Service points are renamed or retired, never removed: past entries name them.
GRANT SELECT, INSERT ON "service_points" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("name", "is_active") ON "service_points" TO hospital_app;
--> statement-breakpoint

-- A queue entry only moves through its lifecycle.
GRANT SELECT, INSERT ON "queue_entries" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("status", "serving_at", "served_by", "ended_at", "ended_by") ON "queue_entries" TO hospital_app;
--> statement-breakpoint

-- Inserted waiting, into an open outpatient visit or emergency attendance, at
-- a service point in use. Then waiting -> serving -> done, or waiting -> left
-- or cancelled, and nothing after that. What the entry was (its visit, its
-- service point, when and by whom it joined) never changes, nor does who
-- served the patient. Never deleted. The service checks all of this first;
-- this is the backstop for every role, the owner included.
CREATE FUNCTION queue_entries_lifecycle() RETURNS trigger
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
    IF NEW.status <> 'waiting' THEN
      RAISE EXCEPTION 'a queue entry starts waiting'
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
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER queue_entries_lifecycle
  BEFORE INSERT OR UPDATE OR DELETE ON "queue_entries"
  FOR EACH ROW EXECUTE FUNCTION queue_entries_lifecycle();
