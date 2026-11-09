CREATE TABLE "gateway_exchanges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"gateway" text NOT NULL,
	"operation" text NOT NULL,
	"stk_request_id" uuid,
	"request" jsonb,
	"response" jsonb,
	"http_status" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_exchanges_gateway_known" CHECK ("gateway_exchanges"."gateway" IN ('daraja')),
	CONSTRAINT "gateway_exchanges_operation_known" CHECK ("gateway_exchanges"."operation" IN ('register_urls', 'stk_push', 'stk_callback')),
	CONSTRAINT "gateway_exchanges_register_has_no_request" CHECK ("gateway_exchanges"."operation" <> 'register_urls' OR "gateway_exchanges"."stk_request_id" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "mpesa_settings" (
	"facility_id" uuid PRIMARY KEY NOT NULL,
	"shortcode" text NOT NULL,
	"credentials" text NOT NULL,
	"callback_token" text NOT NULL,
	"urls_registered_at" timestamp with time zone,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mpesa_settings_callbackToken_unique" UNIQUE("callback_token"),
	CONSTRAINT "mpesa_settings_shortcode_shape" CHECK ("mpesa_settings"."shortcode" ~ '^[0-9]{5,7}$'),
	CONSTRAINT "mpesa_settings_callback_token_shape" CHECK ("mpesa_settings"."callback_token" ~ '^[A-Za-z0-9_-]{43}$')
);
--> statement-breakpoint
CREATE TABLE "mpesa_stk_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"invoice_id" uuid,
	"encounter_id" uuid,
	"phone" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"checkout_request_id" text,
	"result_code" integer,
	"result_desc" text,
	"mpesa_transaction_id" uuid,
	"completed_at" timestamp with time zone,
	CONSTRAINT "mpesa_stk_requests_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "mpesa_stk_requests_status_known" CHECK ("mpesa_stk_requests"."status" IN ('queued', 'sent', 'completed', 'failed')),
	CONSTRAINT "mpesa_stk_requests_phone_e164" CHECK ("mpesa_stk_requests"."phone" ~ '^\+254[0-9]{9}$'),
	CONSTRAINT "mpesa_stk_requests_amount_whole_shillings" CHECK ("mpesa_stk_requests"."amount_cents" > 0 AND "mpesa_stk_requests"."amount_cents" % 100 = 0),
	CONSTRAINT "mpesa_stk_requests_one_target" CHECK ("mpesa_stk_requests"."invoice_id" IS NULL OR "mpesa_stk_requests"."encounter_id" IS NULL),
	CONSTRAINT "mpesa_stk_requests_lifecycle" CHECK (("mpesa_stk_requests"."status" = 'queued' AND "mpesa_stk_requests"."checkout_request_id" IS NULL AND "mpesa_stk_requests"."mpesa_transaction_id" IS NULL AND "mpesa_stk_requests"."completed_at" IS NULL)
      OR ("mpesa_stk_requests"."status" = 'sent' AND "mpesa_stk_requests"."checkout_request_id" IS NOT NULL AND "mpesa_stk_requests"."mpesa_transaction_id" IS NULL AND "mpesa_stk_requests"."completed_at" IS NULL)
      OR ("mpesa_stk_requests"."status" = 'completed' AND "mpesa_stk_requests"."checkout_request_id" IS NOT NULL AND "mpesa_stk_requests"."mpesa_transaction_id" IS NOT NULL AND "mpesa_stk_requests"."completed_at" IS NOT NULL)
      OR ("mpesa_stk_requests"."status" = 'failed' AND "mpesa_stk_requests"."mpesa_transaction_id" IS NULL AND "mpesa_stk_requests"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "mpesa_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"source" text NOT NULL,
	"transaction_id" text NOT NULL,
	"shortcode" text NOT NULL,
	"account_reference" text,
	"msisdn" text NOT NULL,
	"payer_name" text,
	"amount_cents" integer NOT NULL,
	"transacted_at" timestamp with time zone NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"status" text DEFAULT 'unmatched' NOT NULL,
	"status_reason" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mpesa_transactions_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "mpesa_transactions_facility_id_transaction_id_key" UNIQUE("facility_id","transaction_id"),
	CONSTRAINT "mpesa_transactions_source_known" CHECK ("mpesa_transactions"."source" IN ('c2b', 'stk')),
	CONSTRAINT "mpesa_transactions_status_known" CHECK ("mpesa_transactions"."status" IN ('unmatched', 'allocated', 'rejected')),
	CONSTRAINT "mpesa_transactions_amount_whole_shillings" CHECK ("mpesa_transactions"."amount_cents" > 0 AND "mpesa_transactions"."amount_cents" % 100 = 0),
	CONSTRAINT "mpesa_transactions_rejected_reason" CHECK ("mpesa_transactions"."status" <> 'rejected' OR ("mpesa_transactions"."status_reason" IS NOT NULL AND length(btrim("mpesa_transactions"."status_reason")) > 0))
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_known";--> statement-breakpoint
ALTER TABLE "outbox" DROP CONSTRAINT "outbox_operation_known";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_method_known";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_reversal";--> statement-breakpoint
ALTER TABLE "allocations" ALTER COLUMN "allocated_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "received_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "mpesa_transaction_id" uuid;--> statement-breakpoint
ALTER TABLE "gateway_exchanges" ADD CONSTRAINT "gateway_exchanges_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_exchanges" ADD CONSTRAINT "gateway_exchanges_stk_request_fk" FOREIGN KEY ("facility_id","stk_request_id") REFERENCES "public"."mpesa_stk_requests"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_settings" ADD CONSTRAINT "mpesa_settings_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_settings" ADD CONSTRAINT "mpesa_settings_updated_by_fk" FOREIGN KEY ("facility_id","updated_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_stk_requests" ADD CONSTRAINT "mpesa_stk_requests_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_stk_requests" ADD CONSTRAINT "mpesa_stk_requests_patient_fk" FOREIGN KEY ("facility_id","patient_id") REFERENCES "public"."patients"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_stk_requests" ADD CONSTRAINT "mpesa_stk_requests_invoice_fk" FOREIGN KEY ("facility_id","invoice_id") REFERENCES "public"."invoices"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_stk_requests" ADD CONSTRAINT "mpesa_stk_requests_encounter_fk" FOREIGN KEY ("facility_id","encounter_id") REFERENCES "public"."encounters"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_stk_requests" ADD CONSTRAINT "mpesa_stk_requests_requested_by_fk" FOREIGN KEY ("facility_id","requested_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_stk_requests" ADD CONSTRAINT "mpesa_stk_requests_transaction_fk" FOREIGN KEY ("facility_id","mpesa_transaction_id") REFERENCES "public"."mpesa_transactions"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_transactions" ADD CONSTRAINT "mpesa_transactions_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gateway_exchanges_stk_request_index" ON "gateway_exchanges" USING btree ("stk_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mpesa_stk_requests_checkout_index" ON "mpesa_stk_requests" USING btree ("facility_id","checkout_request_id") WHERE "mpesa_stk_requests"."checkout_request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "mpesa_transactions_status_index" ON "mpesa_transactions" USING btree ("facility_id","status");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_mpesa_transaction_fk" FOREIGN KEY ("facility_id","mpesa_transaction_id") REFERENCES "public"."mpesa_transactions"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_one_live_per_mpesa_transaction" ON "payments" USING btree ("mpesa_transaction_id") WHERE "payments"."reversed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_known" CHECK ("audit_log"."action" IN ('facility.created', 'invitation.created', 'invitation.revoked', 'membership.granted', 'membership.roles_changed', 'membership.revoked', 'document.issued', 'document.voided', 'document.viewed', 'document.verified', 'patient.registered', 'patient.updated', 'patient.identifier_added', 'patient.viewed', 'patient.searched', 'encounter.opened', 'encounter.closed', 'encounter.cancelled', 'encounter.viewed', 'patient.admitted', 'patient.transferred', 'patient.discharged', 'ward.created', 'bed.created', 'billable_item.created', 'price_change.requested', 'price_change.approved', 'price_change.rejected', 'price_change.withdrawn', 'ward.bed_day_item_set', 'charge.posted', 'charge.accrued', 'charge.cancelled', 'invoice.drafted', 'invoice.finalised', 'invoice.voided', 'invoice.viewed', 'adjustment.requested', 'adjustment.approved', 'adjustment.rejected', 'adjustment.withdrawn', 'adjustment.listed', 'shift.opened', 'shift.closed', 'payment.recorded', 'payment.reversed', 'allocation.recorded', 'allocation.reversed', 'account.viewed', 'payment.viewed', 'refund.requested', 'refund.approved', 'refund.rejected', 'refund.withdrawn', 'refund.paid', 'refund.reversed', 'refund.listed', 'mpesa.settings_changed', 'mpesa.received', 'mpesa.assigned', 'mpesa.rejected', 'mpesa.listed', 'mpesa.stk_requested'));--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_operation_known" CHECK ("outbox"."operation" IN ('invitation.send', 'mpesa.register_urls', 'mpesa.stk_push'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_mpesa_transaction" CHECK (("payments"."method" IN ('mpesa_c2b', 'mpesa_stk')) = ("payments"."mpesa_transaction_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_received_by" CHECK ("payments"."received_by" IS NOT NULL OR "payments"."method" IN ('mpesa_c2b', 'mpesa_stk'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_method_known" CHECK ("payments"."method" IN ('cash', 'card', 'bank', 'mpesa_c2b', 'mpesa_stk'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reversal" CHECK (("payments"."reversed_at" IS NULL AND "payments"."reversed_by" IS NULL AND "payments"."reversal_reason" IS NULL)
      OR ("payments"."reversed_at" IS NOT NULL AND "payments"."reversed_by" IS NOT NULL AND "payments"."reversal_reason" IS NOT NULL AND length(btrim("payments"."reversal_reason")) > 0
          AND ("payments"."received_by" IS NULL OR "payments"."reversed_by" <> "payments"."received_by")));