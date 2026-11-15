-- Sensitive medicines (P4 slice 3c): row-level security, privileges and the
-- audit action. A mark is changed (a null category unmarks it), never
-- removed, so its history is in the audit log.

ALTER TABLE "sensitive_drugs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sensitive_drugs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sensitive_drugs"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint
GRANT SELECT, INSERT ON "sensitive_drugs" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("category", "marked_by", "marked_at") ON "sensitive_drugs" TO hospital_app;
--> statement-breakpoint

INSERT INTO "audit_actions" ("action") VALUES
  ('drug.sensitivity_set');
