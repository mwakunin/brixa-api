-- Row-level security for the patient register, the same shape as 0001, 0003
-- and 0006: ENABLE and FORCE, one policy for every command with USING and
-- WITH CHECK, no DELETE for the runtime role (CLAUDE.md §4, rule 5).

ALTER TABLE "patients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "patients" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "patients"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

ALTER TABLE "patient_numbers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "patient_numbers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "patient_numbers"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

ALTER TABLE "patient_identifiers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "patient_identifiers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "patient_identifiers"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

-- Demographics are corrected in place, with each change audited (old and new
-- values). Who registered a patient, and when, never changes.
GRANT SELECT, INSERT ON "patients" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE (
  "given_name", "middle_names", "family_name", "date_of_birth", "dob_is_estimated",
  "sex", "phone", "no_phone_reason", "no_id_reason", "unidentified", "updated_at"
) ON "patients" TO hospital_app;
--> statement-breakpoint

-- An issued number is frozen text (SCHEMA.md §6): never edited, never reused.
GRANT SELECT, INSERT ON "patient_numbers" TO hospital_app;
--> statement-breakpoint

-- An identifier entered wrongly is superseded by adding the right one; the
-- wrong one stays as a record of what was on file.
GRANT SELECT, INSERT ON "patient_identifiers" TO hospital_app;
