CREATE TABLE "invoice_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"document_id" uuid,
	CONSTRAINT "invoice_adjustments_kind_known" CHECK ("invoice_adjustments"."kind" IN ('credit_note', 'waiver', 'write_off')),
	CONSTRAINT "invoice_adjustments_status_known" CHECK ("invoice_adjustments"."status" IN ('pending', 'approved', 'rejected', 'withdrawn')),
	CONSTRAINT "invoice_adjustments_amount_whole_shillings" CHECK ("invoice_adjustments"."amount_cents" > 0 AND "invoice_adjustments"."amount_cents" % 100 = 0),
	CONSTRAINT "invoice_adjustments_reason_present" CHECK (length(btrim("invoice_adjustments"."reason")) > 0),
	CONSTRAINT "invoice_adjustments_decision" CHECK (("invoice_adjustments"."status" = 'pending' AND "invoice_adjustments"."decided_by" IS NULL AND "invoice_adjustments"."decided_at" IS NULL)
      OR ("invoice_adjustments"."status" IN ('approved', 'rejected') AND "invoice_adjustments"."decided_by" IS NOT NULL AND "invoice_adjustments"."decided_at" IS NOT NULL
          AND "invoice_adjustments"."decided_by" <> "invoice_adjustments"."requested_by")
      OR ("invoice_adjustments"."status" = 'withdrawn' AND "invoice_adjustments"."decided_by" = "invoice_adjustments"."requested_by" AND "invoice_adjustments"."decided_at" IS NOT NULL)),
	CONSTRAINT "invoice_adjustments_credit_note_document" CHECK (("invoice_adjustments"."kind" = 'credit_note' AND "invoice_adjustments"."status" = 'approved') = ("invoice_adjustments"."document_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_known";--> statement-breakpoint
ALTER TABLE "invoice_adjustments" ADD CONSTRAINT "invoice_adjustments_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_adjustments" ADD CONSTRAINT "invoice_adjustments_invoice_fk" FOREIGN KEY ("facility_id","invoice_id","account_id") REFERENCES "public"."invoices"("facility_id","id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_adjustments" ADD CONSTRAINT "invoice_adjustments_document_fk" FOREIGN KEY ("facility_id","document_id") REFERENCES "public"."documents"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_adjustments" ADD CONSTRAINT "invoice_adjustments_requested_by_fk" FOREIGN KEY ("facility_id","requested_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_adjustments" ADD CONSTRAINT "invoice_adjustments_decided_by_fk" FOREIGN KEY ("facility_id","decided_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_adjustments_invoice_index" ON "invoice_adjustments" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_adjustments_pending_index" ON "invoice_adjustments" USING btree ("facility_id") WHERE "invoice_adjustments"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_known" CHECK ("audit_log"."action" IN ('facility.created', 'invitation.created', 'invitation.revoked', 'membership.granted', 'membership.roles_changed', 'membership.revoked', 'document.issued', 'document.voided', 'document.viewed', 'document.verified', 'patient.registered', 'patient.updated', 'patient.identifier_added', 'patient.viewed', 'patient.searched', 'encounter.opened', 'encounter.closed', 'encounter.cancelled', 'encounter.viewed', 'patient.admitted', 'patient.transferred', 'patient.discharged', 'ward.created', 'bed.created', 'billable_item.created', 'price_change.requested', 'price_change.approved', 'price_change.rejected', 'price_change.withdrawn', 'ward.bed_day_item_set', 'charge.posted', 'charge.accrued', 'charge.cancelled', 'invoice.drafted', 'invoice.finalised', 'invoice.voided', 'invoice.viewed', 'adjustment.requested', 'adjustment.approved', 'adjustment.rejected', 'adjustment.withdrawn'));