-- A result's values are written while it is entered, never after (rule 19):
-- once released or verified, a value added later would read as released or
-- verified with it. The parent row is share-locked, so an insert queues
-- behind a release or verification of the same result and then sees its
-- status. For every role, the owner included.
CREATE FUNCTION lab_result_values_while_entered() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT status INTO parent_status FROM lab_results
    WHERE facility_id = NEW.facility_id AND id = NEW.result_id
    FOR SHARE;
  IF parent_status IS DISTINCT FROM 'entered' THEN
    RAISE EXCEPTION 'a result''s values are written while it is entered'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER lab_result_values_while_entered
  BEFORE INSERT ON "lab_result_values"
  FOR EACH ROW EXECUTE FUNCTION lab_result_values_while_entered();
