-- Encounters, wards and admissions: row-level security, privileges, and the
-- two rules about beds that only an exclusion constraint can hold.

ALTER TABLE "wards" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wards" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "wards"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

ALTER TABLE "beds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "beds" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "beds"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

ALTER TABLE "encounters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "encounters" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "encounters"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

ALTER TABLE "admissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "admissions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "admissions"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

ALTER TABLE "bed_stays" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bed_stays" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "bed_stays"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

-- Wards and beds are renamed or retired, never removed: a past stay names them.
GRANT SELECT, INSERT ON "wards", "beds" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("name", "is_active") ON "wards" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("label", "is_active") ON "beds" TO hospital_app;
--> statement-breakpoint

-- An encounter's patient, kind and start never change; only its lifecycle does.
GRANT SELECT, INSERT ON "encounters" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("status", "ended_at", "closed_by", "cancel_reason", "updated_at") ON "encounters" TO hospital_app;
--> statement-breakpoint

GRANT SELECT, INSERT ON "admissions" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("discharged_at", "discharged_by", "discharge_disposition") ON "admissions" TO hospital_app;
--> statement-breakpoint

-- A stay is ended, never moved: a transfer is a new stay.
GRANT SELECT, INSERT ON "bed_stays" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("ended_at", "ended_by") ON "bed_stays" TO hospital_app;
--> statement-breakpoint

-- No bed holds two patients at once, and no admission is in two beds at
-- once, whatever the application does. An open stay runs to infinity, so it
-- overlaps every later one. btree_gist lets uuid equality share a GiST index
-- with the range.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "bed_stays"
  ADD COLUMN "during" tstzrange GENERATED ALWAYS AS (tstzrange("started_at", "ended_at", '[)')) STORED;
--> statement-breakpoint
ALTER TABLE "bed_stays"
  ADD CONSTRAINT "bed_stays_one_patient_per_bed" EXCLUDE USING gist ("bed_id" WITH =, "during" WITH &&);
--> statement-breakpoint
ALTER TABLE "bed_stays"
  ADD CONSTRAINT "bed_stays_one_bed_per_admission" EXCLUDE USING gist ("admission_id" WITH =, "during" WITH &&);
--> statement-breakpoint

-- A stay that has ended stays ended: a mistaken discharge is corrected by a
-- new admission, not by reopening history.
CREATE FUNCTION bed_stays_end_once() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'a bed stay that has ended cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER bed_stays_end_once
  BEFORE UPDATE ON "bed_stays"
  FOR EACH ROW EXECUTE FUNCTION bed_stays_end_once();
--> statement-breakpoint

-- Admission numbers for facilities onboarded before this series existed:
-- `ADM-` and yearly, as onboarding now registers it. Its counter is created
-- on first use.
INSERT INTO "number_series" ("facility_id", "kind", "prefix", "padding", "reset_period")
SELECT "id", 'admission', 'ADM-', 4, 'yearly' FROM "facilities"
ON CONFLICT ("facility_id", "kind") DO NOTHING;
