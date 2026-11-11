-- Clinical notes: row-level security, privileges, and a note's lifecycle,
-- held for every role.

ALTER TABLE "clinical_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "clinical_notes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "clinical_notes"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

-- A draft's content changes until it is signed or discarded; after that only
-- an entered-in-error mark is ever added.
GRANT SELECT, INSERT ON "clinical_notes" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("presenting_complaint", "history", "examination", "plan", "text", "status", "updated_at",
  "signed_at", "discarded_at", "entered_in_error_at", "entered_in_error_by", "entered_in_error_reason")
  ON "clinical_notes" TO hospital_app;
--> statement-breakpoint

-- For every role, the owner included:
--   * a note is written as a draft; an addendum is written signed, to a
--     signed note on the same encounter, never to an addendum or to a note
--     marked entered in error;
--   * a draft's content changes, then it is signed or discarded, once;
--   * whose note it is, what kind, on which encounter, never changes;
--   * a signed note is frozen: it may only be marked entered in error, once;
--   * a discarded draft never changes; nothing is deleted.
CREATE FUNCTION clinical_notes_lifecycle() RETURNS trigger
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
--> statement-breakpoint
CREATE TRIGGER clinical_notes_lifecycle
  BEFORE INSERT OR UPDATE OR DELETE ON "clinical_notes"
  FOR EACH ROW EXECUTE FUNCTION clinical_notes_lifecycle();
