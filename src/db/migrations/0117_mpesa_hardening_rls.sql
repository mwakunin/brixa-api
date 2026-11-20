-- M-Pesa hardening (decided 2026-11-20, ROADMAP.md P6): what the runtime
-- role may do with the replaced callback token and the replays, and the
-- audit actions.

-- Replacing the token writes the new one, keeps the old one for a while, and
-- registering the new URLs sets when the old one stops (lib/mpesa.ts).
GRANT UPDATE ("callback_token", "previous_callback_token", "previous_token_until", "callback_token_rotated_at") ON "mpesa_settings" TO hospital_app;
--> statement-breakpoint

ALTER TABLE "mpesa_callback_replays" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mpesa_callback_replays" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "mpesa_callback_replays"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint
-- Written once: a replay is recorded and stands.
GRANT SELECT, INSERT ON "mpesa_callback_replays" TO hospital_app;
--> statement-breakpoint

INSERT INTO "audit_actions" ("action") VALUES
  ('mpesa.callback_token_rotated'),
  ('mpesa.callback_replayed');
