-- Repeat-safe writes (decided 2026-11-22): row-level security and the
-- runtime role's privileges. A request records its key, then its answer in
-- the same transaction. Like every tenant table, the runtime role deletes
-- nothing (rule 5): the nightly close forgets day-old keys as the owner.

ALTER TABLE "idempotent_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "idempotent_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "idempotent_requests"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

GRANT SELECT, INSERT ON "idempotent_requests" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("status", "answer", "content_type") ON "idempotent_requests" TO hospital_app;
