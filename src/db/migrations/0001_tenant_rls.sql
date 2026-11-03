-- Row-level security for the tenant tables (CLAUDE.md §4, layer 3).
--
-- Three things must all be true for isolation to be real rather than
-- decorative, and missing any one leaves the other two looking correct in
-- `pg_policies`. There is a test for each in rls.test.ts.
--
--   1. The policies exist                      (this file)
--   2. They apply to the table's owner         (FORCE, below)
--   3. The app does not connect as the owner   (db/roles.sql + APP_DATABASE_URL)

-- The tenant of the current transaction, or NULL if none was set.
--
-- NULLIF guards the empty string: `current_setting(..., true)` returns NULL for
-- a setting never assigned but '' for one set to empty, and ''::uuid raises.
-- A NULL makes every `facility_id = app_current_facility()` comparison NULL,
-- which is not TRUE, so forgetting to set the tenant yields zero rows, never
-- every row.
CREATE FUNCTION app_current_facility() RETURNS uuid
  LANGUAGE sql
  STABLE
  AS $$ SELECT NULLIF(current_setting('app.facility_id', true), '')::uuid $$;
--> statement-breakpoint

-- `facilities` is scoped by its own primary key: a tenant reads its own row
-- and nothing else. Onboarding, listing and suspending happen on the
-- superadmin plane, on the owner connection.
ALTER TABLE "facilities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "facilities" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "facilities"
  FOR ALL
  USING ("id" = app_current_facility())
  WITH CHECK ("id" = app_current_facility());
--> statement-breakpoint

-- WITH CHECK matters as much as USING: without it a handler could still
-- INSERT or UPDATE a row into another facility, the more damaging direction.
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "memberships"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_log"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

-- The audit log is append-only for every role, the owner included (CLAUDE.md
-- rule 9, SCHEMA.md §10). The runtime role is also denied the privilege below;
-- the trigger is what stops a migration, a superadmin handler or a hand-run
-- correction from rewriting history. TRUNCATE (the test harness) does not fire
-- row triggers.
CREATE FUNCTION audit_log_append_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % refused', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
--> statement-breakpoint

-- Privileges for the runtime role.
--
-- No DELETE anywhere (CLAUDE.md rule 5): records are status-transitioned,
-- reversed or superseded, never removed. Withholding the privilege makes a
-- stray DELETE fail in test rather than quietly destroy history.
--
-- `facilities` is read-only to the app. Creating a facility, suspending it and
-- recording its KMHFR code or SHA contract belong to the superadmin plane, on
-- the owner connection; a facility-scoped handler must not be able to lift its
-- own suspension. A facility editing its own settings gets column-level UPDATE
-- when that route exists.
GRANT SELECT ON "facilities" TO hospital_app;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "memberships" TO hospital_app;
--> statement-breakpoint

-- Append-only: no UPDATE either.
GRANT SELECT, INSERT ON "audit_log" TO hospital_app;
--> statement-breakpoint

-- Better Auth's tables, on its own role (db/roles.sql). It needs full DML:
-- signing out deletes a session, and expired verification rows are removed in
-- place. They carry no policies because identity is global; one person may
-- hold memberships at several facilities. Rule 5 covers domain tables; these
-- are Better Auth's.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "user", "session", "account", "verification"
  TO hospital_auth;
--> statement-breakpoint

-- The app role may see who a person is (to list a facility's staff) and
-- nothing else of identity: no session token, no password hash, no
-- verification code, and no platform role. Nothing at all on the other three.
GRANT SELECT ("id", "name", "email") ON "user" TO hospital_app;
