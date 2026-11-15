-- Sensitive records and break-glass (rule 27): row-level security and
-- privileges for the two new tables, the columns the app now writes, a
-- charge's printed name taken at capture, and the lifecycles held for every
-- role.

ALTER TABLE "break_glass_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "break_glass_grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "break_glass_grants"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint
ALTER TABLE "break_glass_alerts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "break_glass_alerts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "break_glass_alerts"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

-- A grant is reviewed once; who is alerted is written with it.
GRANT SELECT, INSERT ON "break_glass_grants" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("reviewed_at", "reviewed_by", "review_note") ON "break_glass_grants" TO hospital_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "break_glass_alerts" TO hospital_app;
--> statement-breakpoint

-- The marks: a clinic and a lab test are marked by those who keep them, a
-- note by its author; a bill's neutral name by the price keepers.
GRANT UPDATE ("sensitive_category") ON "service_points" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("sensitive_category") ON "lab_tests" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("sensitive_category") ON "clinical_notes" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("printed_name") ON "billable_items" TO hospital_app;
--> statement-breakpoint

-- For every role: a grant never changes but for its review, made once; none
-- is deleted.
CREATE FUNCTION break_glass_grants_reviewed_once() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a break-glass grant is kept, never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.reviewed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a break-glass grant is reviewed once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['reviewed_at', 'reviewed_by', 'review_note']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['reviewed_at', 'reviewed_by', 'review_note']) THEN
    RAISE EXCEPTION 'who broke the glass, why and until when never change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER break_glass_grants_reviewed_once
  BEFORE UPDATE OR DELETE ON "break_glass_grants"
  FOR EACH ROW EXECUTE FUNCTION break_glass_grants_reviewed_once();
--> statement-breakpoint

CREATE FUNCTION break_glass_alerts_written_once() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'who is alerted of a break-glass is written with it, never changed'
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER break_glass_alerts_written_once
  BEFORE UPDATE OR DELETE ON "break_glass_alerts"
  FOR EACH ROW EXECUTE FUNCTION break_glass_alerts_written_once();
--> statement-breakpoint

-- Every role: a charge prints its item's printed name, or its name, as the
-- item stood at capture (rule 7). Set here on every insert, whatever the
-- capture path gave.
CREATE FUNCTION charges_printed_name() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  SELECT coalesce(printed_name, name) INTO NEW.printed_name FROM billable_items
    WHERE facility_id = NEW.facility_id AND id = NEW.billable_item_id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER charges_printed_name
  BEFORE INSERT ON "charges"
  FOR EACH ROW EXECUTE FUNCTION charges_printed_name();
--> statement-breakpoint

-- As in 0053, with `printed_name` frozen too.
CREATE OR REPLACE FUNCTION charges_cancel_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'a cancelled charge cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.facility_id IS DISTINCT FROM OLD.facility_id
    OR NEW.encounter_id IS DISTINCT FROM OLD.encounter_id
    OR NEW.billable_item_id IS DISTINCT FROM OLD.billable_item_id
    OR NEW.quantity IS DISTINCT FROM OLD.quantity
    OR NEW.unit_price_cents IS DISTINCT FROM OLD.unit_price_cents
    OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
    OR NEW.price_list_item_id IS DISTINCT FROM OLD.price_list_item_id
    OR NEW.printed_name IS DISTINCT FROM OLD.printed_name
    OR NEW.service_date IS DISTINCT FROM OLD.service_date
    OR NEW.bed_stay_id IS DISTINCT FROM OLD.bed_stay_id
    OR NEW.queue_entry_id IS DISTINCT FROM OLD.queue_entry_id
    OR NEW.order_item_id IS DISTINCT FROM OLD.order_item_id
    OR NEW.manual_reason IS DISTINCT FROM OLD.manual_reason
    OR NEW.captured_by IS DISTINCT FROM OLD.captured_by
    OR NEW.captured_at IS DISTINCT FROM OLD.captured_at
  THEN
    RAISE EXCEPTION 'a charge is cancelled, never edited'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- As in 0051, with the sensitive mark: a note's author marks it once, as a
-- change of its own, on a draft or a signed note, and it is never taken off
-- or changed. A discarded draft still never changes.
CREATE OR REPLACE FUNCTION clinical_notes_lifecycle() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  original record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a note is discarded or marked entered in error, never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.entered_in_error_at IS NOT NULL OR NEW.status = 'discarded'
      OR (NEW.kind = 'addendum') <> (NEW.status = 'signed') THEN
      RAISE EXCEPTION 'a note is written as a draft, an addendum signed'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.kind = 'addendum' THEN
      -- Locked, so an entered-in-error mark cannot land while this is checked.
      SELECT kind, status, encounter_id, entered_in_error_at INTO original FROM clinical_notes
        WHERE facility_id = NEW.facility_id AND id = NEW.addendum_of
        FOR SHARE;
      IF original.status IS DISTINCT FROM 'signed' OR original.encounter_id IS DISTINCT FROM NEW.encounter_id
        OR original.kind = 'addendum' OR original.entered_in_error_at IS NOT NULL THEN
        RAISE EXCEPTION 'an addendum is added to a signed note on its encounter, not to an addendum or a note entered in error'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.facility_id IS DISTINCT FROM OLD.facility_id
    OR NEW.encounter_id IS DISTINCT FROM OLD.encounter_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.addendum_of IS DISTINCT FROM OLD.addendum_of
    OR NEW.written_by IS DISTINCT FROM OLD.written_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'whose note it is, its kind and its encounter never change'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status = 'discarded' THEN
    RAISE EXCEPTION 'a discarded draft cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.sensitive_category IS DISTINCT FROM OLD.sensitive_category THEN
    IF OLD.sensitive_category IS NOT NULL THEN
      RAISE EXCEPTION 'a note marked sensitive stays so'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF (to_jsonb(NEW) - 'sensitive_category') IS DISTINCT FROM (to_jsonb(OLD) - 'sensitive_category') THEN
      RAISE EXCEPTION 'a note is marked sensitive as a change of its own'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'signed' THEN
    IF OLD.entered_in_error_at IS NOT NULL
      OR NEW.status IS DISTINCT FROM OLD.status
      OR NEW.presenting_complaint IS DISTINCT FROM OLD.presenting_complaint
      OR NEW.history IS DISTINCT FROM OLD.history
      OR NEW.examination IS DISTINCT FROM OLD.examination
      OR NEW.plan IS DISTINCT FROM OLD.plan
      OR NEW.text IS DISTINCT FROM OLD.text
      OR NEW.updated_at IS DISTINCT FROM OLD.updated_at
      OR NEW.signed_at IS DISTINCT FROM OLD.signed_at
    THEN
      RAISE EXCEPTION 'a signed note is corrected by an addendum, never edited'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- A draft: its content may change, and it may be signed or discarded.
  IF NEW.entered_in_error_at IS NOT NULL THEN
    RAISE EXCEPTION 'only a signed note is marked entered in error'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
