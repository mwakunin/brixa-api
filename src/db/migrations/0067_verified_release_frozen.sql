-- As in 0063, with the release frozen once a result is verified, even when
-- it was verified without one: a verified result is final (rule 19), and
-- setting a release on it afterwards would print it as released unverified.
CREATE OR REPLACE FUNCTION lab_results_lifecycle() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  lifecycle constant text[] := ARRAY['status', 'released_at', 'released_by', 'release_reason', 'verified_at', 'verified_by',
    'told_name', 'told_how', 'told_at', 'told_recorded_by', 'superseded_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a result is superseded, never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'entered' THEN
      RAISE EXCEPTION 'a result is written entered'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'superseded' THEN
    RAISE EXCEPTION 'a superseded result cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'entered' AND NEW.status IN ('released', 'verified', 'superseded'))
    OR (OLD.status = 'released' AND NEW.status IN ('verified', 'superseded'))
    OR (OLD.status = 'verified' AND NEW.status = 'superseded')
  ) THEN
    RAISE EXCEPTION 'a result moves entered -> released -> verified, or is superseded, never back'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF ((OLD.released_at IS NOT NULL OR OLD.status = 'verified') AND (NEW.released_at, NEW.released_by, NEW.release_reason) IS DISTINCT FROM (OLD.released_at, OLD.released_by, OLD.release_reason))
    OR (OLD.verified_at IS NOT NULL AND (NEW.verified_at, NEW.verified_by) IS DISTINCT FROM (OLD.verified_at, OLD.verified_by))
    OR ((OLD.told_name IS NOT NULL OR OLD.status = 'verified') AND (NEW.told_name, NEW.told_how, NEW.told_at, NEW.told_recorded_by) IS DISTINCT FROM (OLD.told_name, OLD.told_how, OLD.told_at, OLD.told_recorded_by))
  THEN
    RAISE EXCEPTION 'a result is released, verified and its critical value told once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - lifecycle) IS DISTINCT FROM (to_jsonb(OLD) - lifecycle) THEN
    RAISE EXCEPTION 'what a result is for, who entered it and when never change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
