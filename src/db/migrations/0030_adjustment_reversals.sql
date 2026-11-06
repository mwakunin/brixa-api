CREATE TABLE "adjustment_reversals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"adjustment_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	CONSTRAINT "adjustment_reversals_status_known" CHECK ("adjustment_reversals"."status" IN ('pending', 'approved', 'rejected', 'withdrawn')),
	CONSTRAINT "adjustment_reversals_reason_present" CHECK (length(btrim("adjustment_reversals"."reason")) > 0),
	CONSTRAINT "adjustment_reversals_decision" CHECK (("adjustment_reversals"."status" = 'pending' AND "adjustment_reversals"."decided_by" IS NULL AND "adjustment_reversals"."decided_at" IS NULL)
      OR ("adjustment_reversals"."status" IN ('approved', 'rejected') AND "adjustment_reversals"."decided_by" IS NOT NULL AND "adjustment_reversals"."decided_at" IS NOT NULL
          AND "adjustment_reversals"."decided_by" <> "adjustment_reversals"."requested_by")
      OR ("adjustment_reversals"."status" = 'withdrawn' AND "adjustment_reversals"."decided_by" IS NOT NULL AND "adjustment_reversals"."decided_by" = "adjustment_reversals"."requested_by" AND "adjustment_reversals"."decided_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_known";--> statement-breakpoint
ALTER TABLE "invoice_adjustments" ADD COLUMN "reversed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoice_adjustments" ADD COLUMN "reversed_by" uuid;--> statement-breakpoint
ALTER TABLE "invoice_adjustments" ADD COLUMN "reversal_reason" text;--> statement-breakpoint
ALTER TABLE "adjustment_reversals" ADD CONSTRAINT "adjustment_reversals_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The target of the foreign key below, so it comes first.
ALTER TABLE "invoice_adjustments" ADD CONSTRAINT "invoice_adjustments_facility_id_id_key" UNIQUE("facility_id","id");--> statement-breakpoint
ALTER TABLE "adjustment_reversals" ADD CONSTRAINT "adjustment_reversals_adjustment_fk" FOREIGN KEY ("facility_id","adjustment_id") REFERENCES "public"."invoice_adjustments"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adjustment_reversals" ADD CONSTRAINT "adjustment_reversals_requested_by_fk" FOREIGN KEY ("facility_id","requested_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adjustment_reversals" ADD CONSTRAINT "adjustment_reversals_decided_by_fk" FOREIGN KEY ("facility_id","decided_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "adjustment_reversals_one_open" ON "adjustment_reversals" USING btree ("adjustment_id") WHERE "adjustment_reversals"."status" IN ('pending', 'approved');--> statement-breakpoint
ALTER TABLE "invoice_adjustments" ADD CONSTRAINT "invoice_adjustments_reversed_by_fk" FOREIGN KEY ("facility_id","reversed_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_known" CHECK ("audit_log"."action" IN ('facility.created', 'invitation.created', 'invitation.revoked', 'membership.granted', 'membership.roles_changed', 'membership.revoked', 'document.issued', 'document.voided', 'document.viewed', 'document.verified', 'patient.registered', 'patient.updated', 'patient.identifier_added', 'patient.viewed', 'patient.searched', 'encounter.opened', 'encounter.closed', 'encounter.cancelled', 'encounter.viewed', 'patient.admitted', 'patient.transferred', 'patient.discharged', 'ward.created', 'bed.created', 'billable_item.created', 'price_change.requested', 'price_change.approved', 'price_change.rejected', 'price_change.withdrawn', 'ward.bed_day_item_set', 'charge.posted', 'charge.accrued', 'charge.cancelled', 'invoice.drafted', 'invoice.finalised', 'invoice.voided', 'invoice.viewed', 'adjustment.requested', 'adjustment.approved', 'adjustment.rejected', 'adjustment.withdrawn', 'adjustment.listed', 'shift.opened', 'shift.closed', 'payment.recorded', 'payment.reversed', 'allocation.recorded', 'allocation.reversed', 'account.viewed', 'payment.viewed', 'refund.requested', 'refund.approved', 'refund.rejected', 'refund.withdrawn', 'refund.paid', 'refund.reversed', 'refund.listed', 'mpesa.settings_changed', 'mpesa.received', 'mpesa.assigned', 'mpesa.rejected', 'mpesa.listed', 'mpesa.stk_requested', 'adjustment.reversal_requested', 'adjustment.reversed', 'adjustment.reversal_rejected', 'adjustment.reversal_withdrawn', 'adjustment.reversals_listed'));--> statement-breakpoint
ALTER TABLE "invoice_adjustments" ADD CONSTRAINT "invoice_adjustments_reversal" CHECK (("invoice_adjustments"."reversed_at" IS NULL AND "invoice_adjustments"."reversed_by" IS NULL AND "invoice_adjustments"."reversal_reason" IS NULL)
      OR ("invoice_adjustments"."status" = 'approved' AND "invoice_adjustments"."reversed_at" IS NOT NULL AND "invoice_adjustments"."reversed_by" IS NOT NULL
        AND "invoice_adjustments"."reversal_reason" IS NOT NULL AND length(btrim("invoice_adjustments"."reversal_reason")) > 0));