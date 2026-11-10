-- Diagnoses, and the ICD-11 codes they are coded in.

-- icd_codes is shared reference data (CLAUDE.md rule 1): every facility reads
-- the same codes, so it has no facility_id and no row-level security. The app
-- role only reads it; `pnpm icd11:load` writes it as the owner.
GRANT SELECT ON "icd_codes" TO hospital_app;
--> statement-breakpoint

-- Search by name over titles. The queries use this very expression
-- (`lib/icd11.ts`): Postgres uses an expression index only for the same one.
CREATE INDEX "icd_codes_title_search" ON "icd_codes" USING gin (to_tsvector('simple', "title"));
--> statement-breakpoint

ALTER TABLE "diagnoses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "diagnoses" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "diagnoses"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

-- A diagnosis is confirmed, re-ranked or ended; never edited or removed.
GRANT SELECT, INSERT ON "diagnoses" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("certainty", "rank", "confirmed_at", "confirmed_by", "ended_at", "ended_by", "end_reason") ON "diagnoses" TO hospital_app;
--> statement-breakpoint

-- For every role, the owner included: written standing; what was diagnosed,
-- when and by whom never changes; a provisional diagnosis is confirmed once
-- (one made confirmed has no confirmation to add); the rank moves only while
-- it stands; it ends once, and an ended diagnosis never changes. Never deleted.
CREATE FUNCTION diagnoses_lifecycle() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a diagnosis is ended, never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.ended_at IS NOT NULL OR NEW.confirmed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a diagnosis is written standing, with no confirmation yet'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'an ended diagnosis cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.facility_id IS DISTINCT FROM OLD.facility_id
    OR NEW.encounter_id IS DISTINCT FROM OLD.encounter_id
    OR NEW.icd_code IS DISTINCT FROM OLD.icd_code
    OR NEW.icd_title IS DISTINCT FROM OLD.icd_title
    OR NEW.icd_uri IS DISTINCT FROM OLD.icd_uri
    OR NEW.icd_release IS DISTINCT FROM OLD.icd_release
    OR NEW.diagnosed_at IS DISTINCT FROM OLD.diagnosed_at
    OR NEW.diagnosed_by IS DISTINCT FROM OLD.diagnosed_by
  THEN
    RAISE EXCEPTION 'what was diagnosed, when and by whom never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.certainty IS DISTINCT FROM OLD.certainty
    AND NOT (OLD.certainty = 'provisional' AND NEW.certainty = 'confirmed') THEN
    RAISE EXCEPTION 'a diagnosis goes from provisional to confirmed, never back'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (OLD.confirmed_at IS NOT NULL OR OLD.certainty = 'confirmed')
    AND (NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by) THEN
    RAISE EXCEPTION 'a diagnosis is confirmed once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER diagnoses_lifecycle
  BEFORE INSERT OR UPDATE OR DELETE ON "diagnoses"
  FOR EACH ROW EXECUTE FUNCTION diagnoses_lifecycle();
