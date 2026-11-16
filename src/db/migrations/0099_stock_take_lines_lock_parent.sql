-- A line waits for its count's submission (CodeRabbit on #22): the trigger
-- read the parent's status without a lock, so a direct write to a line went
-- through while the count was being submitted, and the sheet then differed
-- from the correction asked for. The parent is now read FOR SHARE: a write
-- waits for a submission or cancellation under way, then sees it and is
-- refused. The application's own writes hold the parent FOR UPDATE already.

CREATE OR REPLACE FUNCTION stock_take_lines_while_counting() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."stock_take_id" IS DISTINCT FROM OLD."stock_take_id" OR NEW."batch_id" IS DISTINCT FROM OLD."batch_id") THEN
    RAISE EXCEPTION 'a stock take''s line keeps its count and its batch'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' OR NOT EXISTS (SELECT 1 FROM "stock_takes" s WHERE s."id" = NEW."stock_take_id" AND s."status" = 'counting' FOR SHARE) THEN
    RAISE EXCEPTION 'a stock take''s lines change only while it is counted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
