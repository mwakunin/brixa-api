-- Today's complaint, recorded at triage (decided 2026-11-20): the runtime role
-- writes it, and each change is audited.

GRANT UPDATE ("complaint", "complaint_recorded_at", "complaint_recorded_by") ON "encounters" TO hospital_app;
--> statement-breakpoint

INSERT INTO "audit_actions" ("action") VALUES
  ('encounter.complaint_recorded');
