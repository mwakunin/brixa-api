-- The sign-in log refuses TRUNCATE too. 0112's row trigger does not fire
-- for TRUNCATE, so the owner could empty the log in one statement. This
-- calls the same refusal, once per statement. The test harness, which
-- empties every table between tests, turns this trigger off around its own
-- TRUNCATE, in the same transaction (src/test/helpers.ts).
CREATE TRIGGER sign_in_events_no_truncate
  BEFORE TRUNCATE ON "sign_in_events"
  FOR EACH STATEMENT EXECUTE FUNCTION sign_in_events_append_only();
