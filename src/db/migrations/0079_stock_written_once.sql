-- A goods-received note and its batches are written once (P4 slice 1b), for
-- every role: the app holds only SELECT and INSERT on them (0077), and these
-- hold the owner too, as orders_written_once does (0053). A batch's cost is
-- what the stock view values it at, so an edit would change stock value with
-- no movement to show for it. A mistyped line is reversed and entered again.
CREATE FUNCTION goods_received_written_once() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'a goods-received note is written once; reverse a line and receive it again'
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER goods_received_written_once
  BEFORE UPDATE OR DELETE ON "goods_received"
  FOR EACH ROW EXECUTE FUNCTION goods_received_written_once();
--> statement-breakpoint
CREATE FUNCTION stock_batches_written_once() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'a batch is written once; reverse its line and receive it again'
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stock_batches_written_once
  BEFORE UPDATE OR DELETE ON "stock_batches"
  FOR EACH ROW EXECUTE FUNCTION stock_batches_written_once();
