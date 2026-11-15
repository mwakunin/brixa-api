CREATE TABLE "break_glass_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	CONSTRAINT "break_glass_alerts_grant_member_key" UNIQUE("grant_id","membership_id")
);
--> statement-breakpoint
CREATE TABLE "break_glass_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"granted_to" uuid NOT NULL,
	"reason" text NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"review_note" text,
	CONSTRAINT "break_glass_grants_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "break_glass_grants_reason_present" CHECK (length(btrim("break_glass_grants"."reason")) > 0),
	CONSTRAINT "break_glass_grants_expires_after" CHECK ("break_glass_grants"."expires_at" > "break_glass_grants"."granted_at"),
	CONSTRAINT "break_glass_grants_review" CHECK (("break_glass_grants"."reviewed_at" IS NULL) = ("break_glass_grants"."reviewed_by" IS NULL)
      AND ("break_glass_grants"."review_note" IS NULL OR ("break_glass_grants"."reviewed_at" IS NOT NULL AND length(btrim("break_glass_grants"."review_note")) > 0)))
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_known";--> statement-breakpoint
ALTER TABLE "billable_items" ADD COLUMN "printed_name" text;--> statement-breakpoint
ALTER TABLE "charges" ADD COLUMN "printed_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Charges captured before printed names: each prints its item's name, as bills did.
-- The cancel-only trigger would refuse touching a cancelled charge.
ALTER TABLE "charges" DISABLE TRIGGER "charges_cancel_only";--> statement-breakpoint
UPDATE "charges" c SET "printed_name" = b."name"
  FROM "billable_items" b
  WHERE b."facility_id" = c."facility_id" AND b."id" = c."billable_item_id";--> statement-breakpoint
ALTER TABLE "charges" ENABLE TRIGGER "charges_cancel_only";--> statement-breakpoint
ALTER TABLE "clinical_notes" ADD COLUMN "sensitive_category" text;--> statement-breakpoint
ALTER TABLE "lab_tests" ADD COLUMN "sensitive_category" text;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "sensitive_categories" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "service_points" ADD COLUMN "sensitive_category" text;--> statement-breakpoint
ALTER TABLE "break_glass_alerts" ADD CONSTRAINT "break_glass_alerts_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_alerts" ADD CONSTRAINT "break_glass_alerts_grant_fk" FOREIGN KEY ("facility_id","grant_id") REFERENCES "public"."break_glass_grants"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_alerts" ADD CONSTRAINT "break_glass_alerts_membership_fk" FOREIGN KEY ("facility_id","membership_id") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_grants" ADD CONSTRAINT "break_glass_grants_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_grants" ADD CONSTRAINT "break_glass_grants_patient_fk" FOREIGN KEY ("facility_id","patient_id") REFERENCES "public"."patients"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_grants" ADD CONSTRAINT "break_glass_grants_granted_to_fk" FOREIGN KEY ("facility_id","granted_to") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_grants" ADD CONSTRAINT "break_glass_grants_reviewed_by_fk" FOREIGN KEY ("facility_id","reviewed_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "break_glass_alerts_membership_index" ON "break_glass_alerts" USING btree ("facility_id","membership_id");--> statement-breakpoint
CREATE INDEX "break_glass_grants_reader_index" ON "break_glass_grants" USING btree ("facility_id","patient_id","granted_to","expires_at");--> statement-breakpoint
CREATE INDEX "break_glass_grants_recent_index" ON "break_glass_grants" USING btree ("facility_id","granted_at");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_known" CHECK ("audit_log"."action" IN ('facility.created', 'invitation.created', 'invitation.revoked', 'membership.granted', 'membership.roles_changed', 'membership.revoked', 'membership.licence_changed', 'document.issued', 'document.voided', 'document.viewed', 'document.verified', 'patient.registered', 'patient.updated', 'patient.identifier_added', 'patient.viewed', 'patient.searched', 'encounter.opened', 'encounter.closed', 'encounter.cancelled', 'encounter.viewed', 'patient.admitted', 'patient.transferred', 'patient.discharged', 'ward.created', 'bed.created', 'billable_item.created', 'price_change.requested', 'price_change.approved', 'price_change.rejected', 'price_change.withdrawn', 'ward.bed_day_item_set', 'charge.posted', 'charge.accrued', 'charge.cancelled', 'invoice.drafted', 'invoice.finalised', 'invoice.voided', 'invoice.viewed', 'adjustment.requested', 'adjustment.approved', 'adjustment.rejected', 'adjustment.withdrawn', 'adjustment.listed', 'shift.opened', 'shift.closed', 'payment.recorded', 'payment.reversed', 'allocation.recorded', 'allocation.reversed', 'account.viewed', 'payment.viewed', 'refund.requested', 'refund.approved', 'refund.rejected', 'refund.withdrawn', 'refund.paid', 'refund.reversed', 'refund.listed', 'mpesa.settings_changed', 'mpesa.received', 'mpesa.assigned', 'mpesa.rejected', 'mpesa.listed', 'mpesa.stk_requested', 'mpesa.stk_viewed', 'adjustment.reversal_requested', 'adjustment.reversed', 'adjustment.reversal_rejected', 'adjustment.reversal_withdrawn', 'adjustment.reversals_listed', 'service_point.created', 'service_point.updated', 'queue.joined', 'queue.served', 'queue.finished', 'queue.removed', 'queue.viewed', 'charge.captured', 'billing.due_listed', 'observation.recorded', 'observation.entered_in_error', 'allergy.recorded', 'allergy.removed', 'diagnosis.recorded', 'diagnosis.confirmed', 'diagnosis.principal_set', 'diagnosis.ended', 'note.drafted', 'note.edited', 'note.signed', 'note.discarded', 'note.addendum_added', 'note.entered_in_error', 'lab_test.created', 'lab_test.updated', 'lab_analyte.added', 'lab_analyte.updated', 'lab_analyte.ranges_set', 'order.placed', 'order_item.cancelled', 'order_item.done', 'prescription.issued', 'prescription.cancelled', 'prescription.allergy_overridden', 'specimen.collected', 'specimen.received', 'specimen.rejected', 'lab.worklist_viewed', 'lab_result.entered', 'lab_result.released', 'lab_result.verified', 'lab_report.issued', 'appointment.booked', 'appointment.moved', 'appointment.cancelled', 'appointment.checked_in', 'appointment.listed', 'patient.sms_reminders_set', 'facility.updated', 'patient.break_glass', 'break_glass.listed', 'break_glass.reviewed', 'membership.sensitive_access_changed', 'note.marked_sensitive', 'billable_item.updated'));--> statement-breakpoint
ALTER TABLE "billable_items" ADD CONSTRAINT "billable_items_printed_name_present" CHECK ("billable_items"."printed_name" IS NULL OR length(btrim("billable_items"."printed_name")) > 0);--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_printed_name_present" CHECK (length(btrim("charges"."printed_name")) > 0);--> statement-breakpoint
ALTER TABLE "clinical_notes" ADD CONSTRAINT "clinical_notes_sensitive_category_known" CHECK ("clinical_notes"."sensitive_category" IN ('hiv', 'mental_health', 'gbv'));--> statement-breakpoint
ALTER TABLE "clinical_notes" ADD CONSTRAINT "clinical_notes_addendum_follows_its_note" CHECK ("clinical_notes"."kind" <> 'addendum' OR "clinical_notes"."sensitive_category" IS NULL);--> statement-breakpoint
ALTER TABLE "lab_tests" ADD CONSTRAINT "lab_tests_sensitive_category_known" CHECK ("lab_tests"."sensitive_category" IN ('hiv', 'mental_health', 'gbv'));--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_sensitive_categories_known" CHECK ("memberships"."sensitive_categories" <@ ARRAY['hiv', 'mental_health', 'gbv']::text[]);--> statement-breakpoint
ALTER TABLE "service_points" ADD CONSTRAINT "service_points_sensitive_category_known" CHECK ("service_points"."sensitive_category" IN ('hiv', 'mental_health', 'gbv'));--> statement-breakpoint
ALTER TABLE "service_points" ADD CONSTRAINT "service_points_sensitive_at_a_clinic" CHECK ("service_points"."kind" = 'consultation' OR "service_points"."sensitive_category" IS NULL);