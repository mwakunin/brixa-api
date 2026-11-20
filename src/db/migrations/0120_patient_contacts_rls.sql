-- A patient's contacts (a child's guardian, decided 2026-11-20): row-level
-- security, the runtime role's privileges, and the audit actions.

ALTER TABLE "patient_contacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "patient_contacts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "patient_contacts"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

-- A contact's details are corrected in place, each change audited with its
-- old and new values. Whose contact it is, who added it and when never
-- change, and a contact is never deleted.
GRANT SELECT, INSERT ON "patient_contacts" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("name", "relationship", "phone", "id_type", "id_value", "updated_at") ON "patient_contacts" TO hospital_app;
--> statement-breakpoint

INSERT INTO "audit_actions" ("action") VALUES
  ('patient.contact_added'),
  ('patient.contact_updated');
