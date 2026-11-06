-- M-Pesa: row-level security, privileges, and the rules that the evidence
-- of money received never changes and that exchanges are append-only.

ALTER TABLE "mpesa_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mpesa_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "mpesa_settings"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

ALTER TABLE "mpesa_transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mpesa_transactions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "mpesa_transactions"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

ALTER TABLE "mpesa_stk_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mpesa_stk_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "mpesa_stk_requests"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

ALTER TABLE "gateway_exchanges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "gateway_exchanges" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "gateway_exchanges"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

GRANT SELECT, INSERT ON "mpesa_settings", "mpesa_transactions", "mpesa_stk_requests", "gateway_exchanges" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("shortcode", "credentials", "updated_by", "updated_at", "urls_registered_at") ON "mpesa_settings" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("status", "status_reason") ON "mpesa_transactions" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("status", "checkout_request_id", "result_code", "result_desc", "mpesa_transaction_id", "completed_at") ON "mpesa_stk_requests" TO hospital_app;
--> statement-breakpoint

-- For every role, the owner included: what Safaricom said never changes and
-- is never removed. Only the decision about the row (its status, and why)
-- moves, so a misplaced payment is always recoverable from the original.
CREATE FUNCTION mpesa_transactions_immutable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'M-Pesa transactions are never removed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'status_reason') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'status_reason') THEN
    RAISE EXCEPTION 'an M-Pesa transaction is kept as Safaricom sent it: only its status may change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mpesa_transactions_immutable
  BEFORE UPDATE OR DELETE ON "mpesa_transactions"
  FOR EACH ROW EXECUTE FUNCTION mpesa_transactions_immutable();
--> statement-breakpoint

-- A prompt's request never changes, a completed one never changes at all,
-- and none is removed. (A failed one may still complete: a prompt we gave up
-- on after a timeout can be paid all the same.)
CREATE FUNCTION mpesa_stk_requests_lifecycle() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'M-Pesa prompts are never removed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION 'a completed M-Pesa prompt cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'checkout_request_id' - 'result_code' - 'result_desc' - 'mpesa_transaction_id' - 'completed_at')
    IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'checkout_request_id' - 'result_code' - 'result_desc' - 'mpesa_transaction_id' - 'completed_at')
  THEN
    RAISE EXCEPTION 'what an M-Pesa prompt asked for never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mpesa_stk_requests_lifecycle
  BEFORE UPDATE OR DELETE ON "mpesa_stk_requests"
  FOR EACH ROW EXECUTE FUNCTION mpesa_stk_requests_lifecycle();
--> statement-breakpoint

-- Exchanges with a gateway are append-only (rule 18).
CREATE FUNCTION gateway_exchanges_append_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'gateway exchanges are append-only'
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER gateway_exchanges_append_only
  BEFORE UPDATE OR DELETE ON "gateway_exchanges"
  FOR EACH ROW EXECUTE FUNCTION gateway_exchanges_append_only();
