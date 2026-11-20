-- The append-only records refuse TRUNCATE too, as the sign-in log does
-- (0114). Their row triggers (0001, 0029, 0059, 0077, 0093) do not fire for
-- TRUNCATE, so the owner could empty one in a single statement: a hand-run
-- command or a migration gone wrong. One refusal, once per statement, for
-- all six:
-- mpesa_transactions' own trigger function lets its status change, and
-- would let a TRUNCATE through. The test harness, which empties every table
-- between tests, turns these triggers off around its own TRUNCATE, in the
-- same transaction (src/test/helpers.ts).
CREATE FUNCTION refuse_truncate() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION '% is never emptied: TRUNCATE refused', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_truncate();
--> statement-breakpoint
CREATE TRIGGER mpesa_transactions_no_truncate
  BEFORE TRUNCATE ON "mpesa_transactions"
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_truncate();
--> statement-breakpoint
CREATE TRIGGER gateway_exchanges_no_truncate
  BEFORE TRUNCATE ON "gateway_exchanges"
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_truncate();
--> statement-breakpoint
CREATE TRIGGER stock_movements_no_truncate
  BEFORE TRUNCATE ON "stock_movements"
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_truncate();
--> statement-breakpoint
CREATE TRIGGER controlled_drug_register_no_truncate
  BEFORE TRUNCATE ON "controlled_drug_register"
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_truncate();
--> statement-breakpoint
CREATE TRIGGER lab_result_reviews_no_truncate
  BEFORE TRUNCATE ON "lab_result_reviews"
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_truncate();
