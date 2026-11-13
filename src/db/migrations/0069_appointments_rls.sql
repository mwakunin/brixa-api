-- Appointments and their SMS reminders: row-level security, privileges, and
-- each one's lifecycle, held for every role. Also the patient's answer to
-- SMS reminders and the facility's phone number, which the app now writes.

ALTER TABLE "appointments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "appointments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "appointments"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint
ALTER TABLE "appointment_reminders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "appointment_reminders" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "appointment_reminders"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

-- An appointment is moved, checked in or cancelled; a reminder is sent, or
-- not. Neither is deleted.
GRANT SELECT, INSERT ON "appointments" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE (
  "scheduled_on", "scheduled_time", "status", "checked_in_at", "checked_in_by", "encounter_id",
  "cancelled_at", "cancelled_by", "cancel_reason", "updated_at"
) ON "appointments" TO hospital_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "appointment_reminders" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE (
  "status", "to_phone", "body", "sending_at", "completed_at", "provider_message_id", "cost_cents", "outcome_note"
) ON "appointment_reminders" TO hospital_app;
--> statement-breakpoint

-- The patient's answer to SMS reminders, recorded with who and when.
GRANT UPDATE ("sms_reminders", "sms_reminders_set_at", "sms_reminders_set_by") ON "patients" TO hospital_app;
--> statement-breakpoint

-- The facility admin sets the number reminders tell patients to call. RLS
-- scopes `facilities` by its own id, so only the facility's own row. The SMS
-- sender stays with the superadmin plane, on the owner connection.
GRANT UPDATE ("phone") ON "facilities" TO hospital_app;
--> statement-breakpoint

-- For every role, the owner included: an appointment is written booked, at a
-- clinic, during one of the patient's own encounters if any; booked moves to
-- checked in (into the patient's own visit) or cancelled; it is moved only
-- while it stays booked; who, where and when it was booked never change; a
-- checked-in or cancelled appointment never changes; nothing is deleted.
CREATE FUNCTION appointments_lifecycle() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  lifecycle constant text[] := ARRAY['status', 'checked_in_at', 'checked_in_by', 'encounter_id', 'cancelled_at', 'cancelled_by', 'cancel_reason', 'updated_at'];
  movable constant text[] := ARRAY['scheduled_on', 'scheduled_time'];
  point record;
  visit record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an appointment is cancelled, never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'booked' THEN
      RAISE EXCEPTION 'an appointment is written booked'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT kind INTO point FROM service_points
      WHERE facility_id = NEW.facility_id AND id = NEW.service_point_id;
    IF point.kind IS DISTINCT FROM 'consultation' THEN
      RAISE EXCEPTION 'an appointment is booked at a clinic'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.booked_during IS NOT NULL THEN
      SELECT patient_id INTO visit FROM encounters
        WHERE facility_id = NEW.facility_id AND id = NEW.booked_during;
      IF visit.patient_id IS DISTINCT FROM NEW.patient_id THEN
        RAISE EXCEPTION 'an appointment is booked during one of the patient''s own encounters'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'booked' THEN
    RAISE EXCEPTION 'a checked-in or cancelled appointment cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - lifecycle - movable) IS DISTINCT FROM (to_jsonb(OLD) - lifecycle - movable) THEN
    RAISE EXCEPTION 'whose an appointment is, where, with whom, and who booked it when never change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status <> 'booked'
    AND (NEW.scheduled_on, NEW.scheduled_time) IS DISTINCT FROM (OLD.scheduled_on, OLD.scheduled_time) THEN
    RAISE EXCEPTION 'an appointment is moved only while it stays booked'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status = 'checked_in' THEN
    SELECT patient_id INTO visit FROM encounters
      WHERE facility_id = NEW.facility_id AND id = NEW.encounter_id;
    IF visit.patient_id IS DISTINCT FROM NEW.patient_id THEN
      RAISE EXCEPTION 'an appointment is checked into the patient''s own visit'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER appointments_lifecycle
  BEFORE INSERT OR UPDATE OR DELETE ON "appointments"
  FOR EACH ROW EXECUTE FUNCTION appointments_lifecycle();
--> statement-breakpoint

-- For every role: a reminder is written scheduled; scheduled moves to sending,
-- failed or skipped, and sending to sent, rejected, failed or skipped; what it
-- sends is copied once, as it starts sending; which appointment and day it is
-- for, and when it is due, never change; a finished reminder never changes;
-- nothing is deleted.
CREATE FUNCTION appointment_reminders_lifecycle() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  lifecycle constant text[] := ARRAY['status', 'to_phone', 'body', 'sending_at', 'completed_at', 'provider_message_id', 'cost_cents', 'outcome_note'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a reminder is finished, never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'scheduled' THEN
      RAISE EXCEPTION 'a reminder is written scheduled'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status NOT IN ('scheduled', 'sending') THEN
    RAISE EXCEPTION 'a finished reminder cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'scheduled' AND NEW.status IN ('sending', 'failed', 'skipped'))
    OR (OLD.status = 'sending' AND NEW.status IN ('sent', 'rejected', 'failed', 'skipped'))
  ) THEN
    RAISE EXCEPTION 'a reminder moves scheduled -> sending -> sent, rejected, failed or skipped, never back'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'sending'
    AND (NEW.to_phone, NEW.body, NEW.sending_at) IS DISTINCT FROM (OLD.to_phone, OLD.body, OLD.sending_at) THEN
    RAISE EXCEPTION 'what a reminder sends is copied once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - lifecycle) IS DISTINCT FROM (to_jsonb(OLD) - lifecycle) THEN
    RAISE EXCEPTION 'which appointment and day a reminder is for, and when it is due, never change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER appointment_reminders_lifecycle
  BEFORE INSERT OR UPDATE OR DELETE ON "appointment_reminders"
  FOR EACH ROW EXECUTE FUNCTION appointment_reminders_lifecycle();
