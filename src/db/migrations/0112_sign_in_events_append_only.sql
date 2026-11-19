-- The sign-in log (decided 2026-11-19, SPEC.md §2): append-only for every
-- role, the owner included, as the audit log is (0001), and kept for 20
-- years, so nothing deletes from it. TRUNCATE (the test harness) does not
-- fire row triggers.
CREATE FUNCTION sign_in_events_append_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'sign_in_events is append-only: % refused', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER sign_in_events_append_only
  BEFORE UPDATE OR DELETE ON "sign_in_events"
  FOR EACH ROW EXECUTE FUNCTION sign_in_events_append_only();
--> statement-breakpoint

-- Better Auth's role writes each event and cannot read one back: a stolen
-- session or a bug on that connection cannot list who signs in from where.
-- Brixa support exports the log on the owner connection. The app role gets
-- nothing.
GRANT INSERT ON "sign_in_events" TO hospital_auth;
