-- Row-level security for the onboarding tables, the same shape as 0001:
-- ENABLE and FORCE, one policy for every command with USING and WITH CHECK,
-- no DELETE for the runtime role (CLAUDE.md §4, rule 5). rls.test.ts checks
-- each of these by name, so a table added later without them fails a test.

ALTER TABLE "number_series" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "number_series" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "number_series"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

ALTER TABLE "number_series_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "number_series_counters" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "number_series_counters"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

ALTER TABLE "outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outbox" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "outbox"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invitations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invitations"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "invitations" TO hospital_app;
--> statement-breakpoint

-- Number series, column by column. Issuing a number moves a counter, and a
-- facility admin may change a prefix or padding (going forward). Nothing in
-- the app may re-point a counter or change what a series counts or when it
-- resets: a rewound counter would issue a fiscal number twice (rules 19, 20).
GRANT SELECT, INSERT ON "number_series", "number_series_counters" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("prefix", "padding", "updated_at") ON "number_series" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("next_value") ON "number_series_counters" TO hospital_app;
--> statement-breakpoint

-- And for every role, the owner included: a counter only moves forward and
-- stays attached to its series and period; a series keeps its kind and its
-- reset period. A hand-run correction that needs otherwise is a migration.
CREATE FUNCTION number_series_counters_forward_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.next_value < OLD.next_value
    OR NEW.series_id IS DISTINCT FROM OLD.series_id
    OR NEW.period_key IS DISTINCT FROM OLD.period_key
    OR NEW.facility_id IS DISTINCT FROM OLD.facility_id
  THEN
    RAISE EXCEPTION 'number_series_counters only count forward'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER number_series_counters_forward_only
  BEFORE UPDATE ON "number_series_counters"
  FOR EACH ROW EXECUTE FUNCTION number_series_counters_forward_only();
--> statement-breakpoint

CREATE FUNCTION number_series_fixed() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.reset_period IS DISTINCT FROM OLD.reset_period
    OR NEW.facility_id IS DISTINCT FROM OLD.facility_id
  THEN
    RAISE EXCEPTION 'a number series keeps its kind and reset period'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER number_series_fixed
  BEFORE UPDATE ON "number_series"
  FOR EACH ROW EXECUTE FUNCTION number_series_fixed();
--> statement-breakpoint

-- A request may enqueue an external call and read what it queued, but only
-- the worker (on the owner connection) claims a job or records its outcome.
-- A handler that could mark a job done could also suppress one.
GRANT SELECT, INSERT ON "outbox" TO hospital_app;
