ALTER TABLE "gateway_exchanges" DROP CONSTRAINT "gateway_exchanges_operation_known";--> statement-breakpoint
ALTER TABLE "gateway_exchanges" DROP CONSTRAINT "gateway_exchanges_register_has_no_request";--> statement-breakpoint
ALTER TABLE "mpesa_stk_requests" DROP CONSTRAINT "mpesa_stk_requests_status_known";--> statement-breakpoint
ALTER TABLE "mpesa_stk_requests" DROP CONSTRAINT "mpesa_stk_requests_lifecycle";--> statement-breakpoint
DROP INDEX "job_failures_open_once";--> statement-breakpoint
CREATE UNIQUE INDEX "job_failures_open_once" ON "job_failures" USING btree ("facility_id","job",coalesce("subject_id", '00000000-0000-0000-0000-000000000000'::uuid),"error") WHERE "job_failures"."resolved_at" IS NULL;--> statement-breakpoint
ALTER TABLE "gateway_exchanges" ADD CONSTRAINT "gateway_exchanges_operation_known" CHECK ("gateway_exchanges"."operation" IN ('register_urls', 'stk_push', 'stk_callback', 'c2b_confirmation'));--> statement-breakpoint
ALTER TABLE "gateway_exchanges" ADD CONSTRAINT "gateway_exchanges_register_has_no_request" CHECK ("gateway_exchanges"."operation" NOT IN ('register_urls', 'c2b_confirmation') OR "gateway_exchanges"."stk_request_id" IS NULL);--> statement-breakpoint
ALTER TABLE "mpesa_stk_requests" ADD CONSTRAINT "mpesa_stk_requests_status_known" CHECK ("mpesa_stk_requests"."status" IN ('queued', 'sending', 'sent', 'completed', 'failed'));--> statement-breakpoint
ALTER TABLE "mpesa_stk_requests" ADD CONSTRAINT "mpesa_stk_requests_lifecycle" CHECK (("mpesa_stk_requests"."status" IN ('queued', 'sending') AND "mpesa_stk_requests"."checkout_request_id" IS NULL AND "mpesa_stk_requests"."mpesa_transaction_id" IS NULL AND "mpesa_stk_requests"."completed_at" IS NULL)
      OR ("mpesa_stk_requests"."status" = 'sent' AND "mpesa_stk_requests"."checkout_request_id" IS NOT NULL AND "mpesa_stk_requests"."mpesa_transaction_id" IS NULL AND "mpesa_stk_requests"."completed_at" IS NULL)
      OR ("mpesa_stk_requests"."status" = 'completed' AND "mpesa_stk_requests"."checkout_request_id" IS NOT NULL AND "mpesa_stk_requests"."mpesa_transaction_id" IS NOT NULL AND "mpesa_stk_requests"."completed_at" IS NOT NULL)
      OR ("mpesa_stk_requests"."status" = 'failed' AND "mpesa_stk_requests"."mpesa_transaction_id" IS NULL AND "mpesa_stk_requests"."completed_at" IS NOT NULL));