-- Lab results and reports: row-level security, privileges, the report
-- series, and a result's lifecycle, held for every role.

ALTER TABLE "lab_results" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "lab_results" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "lab_results"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint
ALTER TABLE "lab_result_values" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "lab_result_values" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "lab_result_values"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint
ALTER TABLE "lab_reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "lab_reports" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "lab_reports"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

-- A result is released, verified or superseded; its values and a report are
-- written once.
GRANT SELECT, INSERT ON "lab_results" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("status", "released_at", "released_by", "release_reason", "verified_at", "verified_by",
  "told_name", "told_how", "told_at", "told_recorded_by", "superseded_at")
  ON "lab_results" TO hospital_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "lab_result_values", "lab_reports" TO hospital_app;
--> statement-breakpoint

-- The lab report series for facilities onboarded before it existed, as
-- onboarding now registers it: yearly, six digits (LR-2026-000001).
INSERT INTO "number_series" ("facility_id", "kind", "prefix", "padding", "reset_period")
SELECT f."id", 'lab_report', 'LR-', 6, 'yearly'
FROM "facilities" f
ON CONFLICT ("facility_id", "kind") DO NOTHING;
--> statement-breakpoint

-- For every role, the owner included: a result is written entered; it moves
-- entered -> released -> verified, and to superseded from any of them; who
-- was told is recorded once; a superseded result never changes; its values,
-- who entered it and when never change; nothing is deleted.
CREATE FUNCTION lab_results_lifecycle() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  lifecycle constant text[] := ARRAY['status', 'released_at', 'released_by', 'release_reason', 'verified_at', 'verified_by',
    'told_name', 'told_how', 'told_at', 'told_recorded_by', 'superseded_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a result is superseded, never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'entered' THEN
      RAISE EXCEPTION 'a result is written entered'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'superseded' THEN
    RAISE EXCEPTION 'a superseded result cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'entered' AND NEW.status IN ('released', 'verified', 'superseded'))
    OR (OLD.status = 'released' AND NEW.status IN ('verified', 'superseded'))
    OR (OLD.status = 'verified' AND NEW.status = 'superseded')
  ) THEN
    RAISE EXCEPTION 'a result moves entered -> released -> verified, or is superseded, never back'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (OLD.released_at IS NOT NULL AND (NEW.released_at, NEW.released_by, NEW.release_reason) IS DISTINCT FROM (OLD.released_at, OLD.released_by, OLD.release_reason))
    OR (OLD.verified_at IS NOT NULL AND (NEW.verified_at, NEW.verified_by) IS DISTINCT FROM (OLD.verified_at, OLD.verified_by))
    OR (OLD.told_name IS NOT NULL AND (NEW.told_name, NEW.told_how, NEW.told_at, NEW.told_recorded_by) IS DISTINCT FROM (OLD.told_name, OLD.told_how, OLD.told_at, OLD.told_recorded_by))
  THEN
    RAISE EXCEPTION 'a result is released, verified and its critical value told once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - lifecycle) IS DISTINCT FROM (to_jsonb(OLD) - lifecycle) THEN
    RAISE EXCEPTION 'what a result is for, who entered it and when never change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER lab_results_lifecycle
  BEFORE INSERT OR UPDATE OR DELETE ON "lab_results"
  FOR EACH ROW EXECUTE FUNCTION lab_results_lifecycle();
--> statement-breakpoint

-- For every role: a result's values and an order's reports are written once.
CREATE FUNCTION lab_written_once() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION '% rows are written once, never changed or deleted', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER lab_result_values_written_once
  BEFORE UPDATE OR DELETE ON "lab_result_values"
  FOR EACH ROW EXECUTE FUNCTION lab_written_once();
--> statement-breakpoint
CREATE TRIGGER lab_reports_written_once
  BEFORE UPDATE OR DELETE ON "lab_reports"
  FOR EACH ROW EXECUTE FUNCTION lab_written_once();
