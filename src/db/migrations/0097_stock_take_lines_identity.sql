-- A stock take's line is its count's, of its batch, for good (CodeRabbit on
-- #22): an update checked only the new parent, so the owner could move a
-- submitted count's line to an open count, off the final sheet. A line now
-- never changes count or batch, and changes at all only while the count it
-- belongs to is counting.

CREATE OR REPLACE FUNCTION stock_take_lines_while_counting() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."stock_take_id" IS DISTINCT FROM OLD."stock_take_id" OR NEW."batch_id" IS DISTINCT FROM OLD."batch_id") THEN
    RAISE EXCEPTION 'a stock take''s line keeps its count and its batch'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' OR NOT EXISTS (SELECT 1 FROM "stock_takes" s WHERE s."id" = NEW."stock_take_id" AND s."status" = 'counting') THEN
    RAISE EXCEPTION 'a stock take''s lines change only while it is counted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
