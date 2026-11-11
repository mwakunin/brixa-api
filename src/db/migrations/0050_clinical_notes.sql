CREATE TABLE "clinical_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"addendum_of" uuid,
	"presenting_complaint" text,
	"history" text,
	"examination" text,
	"plan" text,
	"text" text,
	"status" text NOT NULL,
	"written_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"signed_at" timestamp with time zone,
	"discarded_at" timestamp with time zone,
	"entered_in_error_at" timestamp with time zone,
	"entered_in_error_by" uuid,
	"entered_in_error_reason" text,
	CONSTRAINT "clinical_notes_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "clinical_notes_kind_known" CHECK ("clinical_notes"."kind" IN ('consultation', 'nursing', 'addendum')),
	CONSTRAINT "clinical_notes_status_known" CHECK ("clinical_notes"."status" IN ('draft', 'signed', 'discarded')),
	CONSTRAINT "clinical_notes_shape" CHECK (("clinical_notes"."kind" = 'consultation' AND "clinical_notes"."text" IS NULL AND "clinical_notes"."addendum_of" IS NULL
          AND num_nonnulls("clinical_notes"."presenting_complaint", "clinical_notes"."history", "clinical_notes"."examination", "clinical_notes"."plan") >= 1)
      OR ("clinical_notes"."kind" = 'nursing' AND "clinical_notes"."text" IS NOT NULL AND "clinical_notes"."addendum_of" IS NULL
          AND num_nonnulls("clinical_notes"."presenting_complaint", "clinical_notes"."history", "clinical_notes"."examination", "clinical_notes"."plan") = 0)
      OR ("clinical_notes"."kind" = 'addendum' AND "clinical_notes"."text" IS NOT NULL AND "clinical_notes"."addendum_of" IS NOT NULL
          AND num_nonnulls("clinical_notes"."presenting_complaint", "clinical_notes"."history", "clinical_notes"."examination", "clinical_notes"."plan") = 0)),
	CONSTRAINT "clinical_notes_text_present" CHECK (("clinical_notes"."text" IS NULL OR length(btrim("clinical_notes"."text")) > 0)
      AND ("clinical_notes"."presenting_complaint" IS NULL OR length(btrim("clinical_notes"."presenting_complaint")) > 0)
      AND ("clinical_notes"."history" IS NULL OR length(btrim("clinical_notes"."history")) > 0)
      AND ("clinical_notes"."examination" IS NULL OR length(btrim("clinical_notes"."examination")) > 0)
      AND ("clinical_notes"."plan" IS NULL OR length(btrim("clinical_notes"."plan")) > 0)),
	CONSTRAINT "clinical_notes_lifecycle" CHECK (("clinical_notes"."status" = 'draft' AND "clinical_notes"."signed_at" IS NULL AND "clinical_notes"."discarded_at" IS NULL)
      OR ("clinical_notes"."status" = 'signed' AND "clinical_notes"."signed_at" IS NOT NULL AND "clinical_notes"."discarded_at" IS NULL)
      OR ("clinical_notes"."status" = 'discarded' AND "clinical_notes"."discarded_at" IS NOT NULL AND "clinical_notes"."signed_at" IS NULL)),
	CONSTRAINT "clinical_notes_error_complete" CHECK (("clinical_notes"."entered_in_error_at" IS NULL AND "clinical_notes"."entered_in_error_by" IS NULL AND "clinical_notes"."entered_in_error_reason" IS NULL)
      OR ("clinical_notes"."entered_in_error_at" IS NOT NULL AND "clinical_notes"."entered_in_error_by" IS NOT NULL AND "clinical_notes"."status" = 'signed'
          AND "clinical_notes"."entered_in_error_reason" IS NOT NULL AND length(btrim("clinical_notes"."entered_in_error_reason")) > 0))
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_known";--> statement-breakpoint
ALTER TABLE "clinical_notes" ADD CONSTRAINT "clinical_notes_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_notes" ADD CONSTRAINT "clinical_notes_encounter_fk" FOREIGN KEY ("facility_id","encounter_id") REFERENCES "public"."encounters"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_notes" ADD CONSTRAINT "clinical_notes_addendum_of_fk" FOREIGN KEY ("facility_id","addendum_of") REFERENCES "public"."clinical_notes"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_notes" ADD CONSTRAINT "clinical_notes_written_by_fk" FOREIGN KEY ("facility_id","written_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_notes" ADD CONSTRAINT "clinical_notes_entered_in_error_by_fk" FOREIGN KEY ("facility_id","entered_in_error_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clinical_notes_encounter_index" ON "clinical_notes" USING btree ("facility_id","encounter_id","created_at");--> statement-breakpoint
CREATE INDEX "clinical_notes_addendum_of_index" ON "clinical_notes" USING btree ("facility_id","addendum_of");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_known" CHECK ("audit_log"."action" IN ('facility.created', 'invitation.created', 'invitation.revoked', 'membership.granted', 'membership.roles_changed', 'membership.revoked', 'membership.licence_changed', 'document.issued', 'document.voided', 'document.viewed', 'document.verified', 'patient.registered', 'patient.updated', 'patient.identifier_added', 'patient.viewed', 'patient.searched', 'encounter.opened', 'encounter.closed', 'encounter.cancelled', 'encounter.viewed', 'patient.admitted', 'patient.transferred', 'patient.discharged', 'ward.created', 'bed.created', 'billable_item.created', 'price_change.requested', 'price_change.approved', 'price_change.rejected', 'price_change.withdrawn', 'ward.bed_day_item_set', 'charge.posted', 'charge.accrued', 'charge.cancelled', 'invoice.drafted', 'invoice.finalised', 'invoice.voided', 'invoice.viewed', 'adjustment.requested', 'adjustment.approved', 'adjustment.rejected', 'adjustment.withdrawn', 'adjustment.listed', 'shift.opened', 'shift.closed', 'payment.recorded', 'payment.reversed', 'allocation.recorded', 'allocation.reversed', 'account.viewed', 'payment.viewed', 'refund.requested', 'refund.approved', 'refund.rejected', 'refund.withdrawn', 'refund.paid', 'refund.reversed', 'refund.listed', 'mpesa.settings_changed', 'mpesa.received', 'mpesa.assigned', 'mpesa.rejected', 'mpesa.listed', 'mpesa.stk_requested', 'mpesa.stk_viewed', 'adjustment.reversal_requested', 'adjustment.reversed', 'adjustment.reversal_rejected', 'adjustment.reversal_withdrawn', 'adjustment.reversals_listed', 'service_point.created', 'service_point.updated', 'queue.joined', 'queue.served', 'queue.finished', 'queue.removed', 'queue.viewed', 'charge.captured', 'billing.due_listed', 'observation.recorded', 'observation.entered_in_error', 'allergy.recorded', 'allergy.removed', 'diagnosis.recorded', 'diagnosis.confirmed', 'diagnosis.principal_set', 'diagnosis.ended', 'note.drafted', 'note.edited', 'note.signed', 'note.discarded', 'note.addendum_added', 'note.entered_in_error'));