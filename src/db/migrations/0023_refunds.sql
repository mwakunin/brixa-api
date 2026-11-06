CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"paid_by" uuid,
	"method" text,
	"reference" text,
	"cashier_shift_id" uuid,
	"document_id" uuid,
	"reversed_at" timestamp with time zone,
	"reversed_by" uuid,
	"reversal_reason" text,
	CONSTRAINT "refunds_status_known" CHECK ("refunds"."status" IN ('pending', 'approved', 'rejected', 'withdrawn')),
	CONSTRAINT "refunds_method_known" CHECK ("refunds"."method" IN ('cash', 'card', 'bank', 'mpesa')),
	CONSTRAINT "refunds_amount_whole_shillings" CHECK ("refunds"."amount_cents" > 0 AND "refunds"."amount_cents" % 100 = 0),
	CONSTRAINT "refunds_reason_present" CHECK (length(btrim("refunds"."reason")) > 0),
	CONSTRAINT "refunds_decision" CHECK (("refunds"."status" = 'pending' AND "refunds"."decided_by" IS NULL AND "refunds"."decided_at" IS NULL)
      OR ("refunds"."status" IN ('approved', 'rejected') AND "refunds"."decided_by" IS NOT NULL AND "refunds"."decided_at" IS NOT NULL
          AND "refunds"."decided_by" <> "refunds"."requested_by")
      OR ("refunds"."status" = 'withdrawn' AND "refunds"."decided_by" = "refunds"."requested_by" AND "refunds"."decided_at" IS NOT NULL)),
	CONSTRAINT "refunds_payout" CHECK (("refunds"."paid_at" IS NULL AND "refunds"."paid_by" IS NULL AND "refunds"."method" IS NULL AND "refunds"."reference" IS NULL
        AND "refunds"."cashier_shift_id" IS NULL AND "refunds"."document_id" IS NULL)
      OR ("refunds"."status" = 'approved' AND "refunds"."paid_at" IS NOT NULL AND "refunds"."paid_by" IS NOT NULL AND "refunds"."document_id" IS NOT NULL
        AND (("refunds"."method" = 'cash' AND "refunds"."reference" IS NULL AND "refunds"."cashier_shift_id" IS NOT NULL)
          OR ("refunds"."method" = 'card' AND "refunds"."reference" IS NOT NULL AND length(btrim("refunds"."reference")) > 0 AND "refunds"."cashier_shift_id" IS NOT NULL)
          OR ("refunds"."method" IN ('bank', 'mpesa') AND "refunds"."reference" IS NOT NULL AND length(btrim("refunds"."reference")) > 0 AND "refunds"."cashier_shift_id" IS NULL)))),
	CONSTRAINT "refunds_reversal" CHECK (("refunds"."reversed_at" IS NULL AND "refunds"."reversed_by" IS NULL AND "refunds"."reversal_reason" IS NULL)
      OR ("refunds"."status" = 'approved' AND "refunds"."reversed_at" IS NOT NULL AND "refunds"."reversed_by" IS NOT NULL
        AND "refunds"."reversal_reason" IS NOT NULL AND length(btrim("refunds"."reversal_reason")) > 0
        AND ("refunds"."paid_by" IS NULL OR "refunds"."reversed_by" <> "refunds"."paid_by")))
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_known";--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_kind_known";--> statement-breakpoint
ALTER TABLE "number_series" DROP CONSTRAINT "number_series_kind_known";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_reference";--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_fk" FOREIGN KEY ("facility_id","payment_id","account_id") REFERENCES "public"."payments"("facility_id","id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_shift_fk" FOREIGN KEY ("facility_id","cashier_shift_id","paid_by") REFERENCES "public"."cashier_shifts"("facility_id","id","cashier_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_document_fk" FOREIGN KEY ("facility_id","document_id") REFERENCES "public"."documents"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requested_by_fk" FOREIGN KEY ("facility_id","requested_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_decided_by_fk" FOREIGN KEY ("facility_id","decided_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_paid_by_fk" FOREIGN KEY ("facility_id","paid_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_reversed_by_fk" FOREIGN KEY ("facility_id","reversed_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refunds_payment_index" ON "refunds" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "refunds_shift_index" ON "refunds" USING btree ("cashier_shift_id");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_known" CHECK ("audit_log"."action" IN ('facility.created', 'invitation.created', 'invitation.revoked', 'membership.granted', 'membership.roles_changed', 'membership.revoked', 'document.issued', 'document.voided', 'document.viewed', 'document.verified', 'patient.registered', 'patient.updated', 'patient.identifier_added', 'patient.viewed', 'patient.searched', 'encounter.opened', 'encounter.closed', 'encounter.cancelled', 'encounter.viewed', 'patient.admitted', 'patient.transferred', 'patient.discharged', 'ward.created', 'bed.created', 'billable_item.created', 'price_change.requested', 'price_change.approved', 'price_change.rejected', 'price_change.withdrawn', 'ward.bed_day_item_set', 'charge.posted', 'charge.accrued', 'charge.cancelled', 'invoice.drafted', 'invoice.finalised', 'invoice.voided', 'invoice.viewed', 'adjustment.requested', 'adjustment.approved', 'adjustment.rejected', 'adjustment.withdrawn', 'adjustment.listed', 'shift.opened', 'shift.closed', 'payment.recorded', 'payment.reversed', 'allocation.recorded', 'allocation.reversed', 'account.viewed', 'payment.viewed', 'refund.requested', 'refund.approved', 'refund.rejected', 'refund.withdrawn', 'refund.paid', 'refund.reversed', 'refund.listed'));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_kind_known" CHECK ("documents"."kind" IN ('receipt', 'invoice', 'credit_note', 'refund'));--> statement-breakpoint
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_kind_known" CHECK ("number_series"."kind" IN ('outpatient', 'inpatient', 'admission', 'receipt', 'invoice', 'credit_note', 'refund'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reference" CHECK (("payments"."method" = 'cash' AND "payments"."reference" IS NULL)
      OR ("payments"."method" <> 'cash' AND "payments"."reference" IS NOT NULL AND length(btrim("payments"."reference")) > 0));