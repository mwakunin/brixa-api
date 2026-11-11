CREATE TABLE "observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"code" text NOT NULL,
	"value" numeric(7, 2) NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"recorded_by" uuid NOT NULL,
	"entered_in_error_at" timestamp with time zone,
	"entered_in_error_by" uuid,
	"entered_in_error_reason" text,
	CONSTRAINT "observations_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "observations_code_known" CHECK ("observations"."code" IN ('temperature', 'pulse', 'respiratory_rate', 'bp_systolic', 'bp_diastolic', 'spo2', 'weight', 'height', 'muac', 'blood_glucose', 'pain_score')),
	CONSTRAINT "observations_value_plausible" CHECK (CASE "observations"."code" WHEN 'temperature' THEN "observations"."value" BETWEEN 25 AND 45 WHEN 'pulse' THEN "observations"."value" BETWEEN 20 AND 300 WHEN 'respiratory_rate' THEN "observations"."value" BETWEEN 2 AND 90 WHEN 'bp_systolic' THEN "observations"."value" BETWEEN 40 AND 300 WHEN 'bp_diastolic' THEN "observations"."value" BETWEEN 20 AND 200 WHEN 'spo2' THEN "observations"."value" BETWEEN 40 AND 100 WHEN 'weight' THEN "observations"."value" BETWEEN 0.3 AND 400 WHEN 'height' THEN "observations"."value" BETWEEN 20 AND 250 WHEN 'muac' THEN "observations"."value" BETWEEN 5 AND 60 WHEN 'blood_glucose' THEN "observations"."value" BETWEEN 0.5 AND 60 WHEN 'pain_score' THEN "observations"."value" BETWEEN 0 AND 10 ELSE false END),
	CONSTRAINT "observations_error_complete" CHECK (("observations"."entered_in_error_at" IS NULL AND "observations"."entered_in_error_by" IS NULL AND "observations"."entered_in_error_reason" IS NULL)
      OR ("observations"."entered_in_error_at" IS NOT NULL AND "observations"."entered_in_error_by" IS NOT NULL
          AND "observations"."entered_in_error_reason" IS NOT NULL AND length(btrim("observations"."entered_in_error_reason")) > 0))
);
--> statement-breakpoint
CREATE TABLE "patient_allergies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"category" text NOT NULL,
	"allergen" text,
	"reaction" text,
	"severity" text,
	"recorded_at" timestamp with time zone NOT NULL,
	"recorded_by" uuid NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" uuid,
	"removal_reason" text,
	CONSTRAINT "patient_allergies_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "patient_allergies_category_known" CHECK ("patient_allergies"."category" IN ('drug', 'food', 'environment', 'other', 'none_known')),
	CONSTRAINT "patient_allergies_severity_known" CHECK ("patient_allergies"."severity" IN ('mild', 'moderate', 'severe')),
	CONSTRAINT "patient_allergies_removal_reason_known" CHECK ("patient_allergies"."removal_reason" IN ('entered_in_error', 'no_longer_applies')),
	CONSTRAINT "patient_allergies_allergen_unless_none_known" CHECK (("patient_allergies"."category" = 'none_known' AND "patient_allergies"."allergen" IS NULL AND "patient_allergies"."reaction" IS NULL AND "patient_allergies"."severity" IS NULL)
      OR ("patient_allergies"."category" <> 'none_known' AND "patient_allergies"."allergen" IS NOT NULL AND length(btrim("patient_allergies"."allergen")) > 0)),
	CONSTRAINT "patient_allergies_removal_complete" CHECK (("patient_allergies"."removed_at" IS NULL AND "patient_allergies"."removed_by" IS NULL AND "patient_allergies"."removal_reason" IS NULL)
      OR ("patient_allergies"."removed_at" IS NOT NULL AND "patient_allergies"."removed_by" IS NOT NULL AND "patient_allergies"."removal_reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_known";--> statement-breakpoint
ALTER TABLE "queue_entries" ADD COLUMN "priority" text;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_encounter_fk" FOREIGN KEY ("facility_id","encounter_id") REFERENCES "public"."encounters"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_recorded_by_fk" FOREIGN KEY ("facility_id","recorded_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_entered_in_error_by_fk" FOREIGN KEY ("facility_id","entered_in_error_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_allergies" ADD CONSTRAINT "patient_allergies_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_allergies" ADD CONSTRAINT "patient_allergies_patient_fk" FOREIGN KEY ("facility_id","patient_id") REFERENCES "public"."patients"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_allergies" ADD CONSTRAINT "patient_allergies_recorded_by_fk" FOREIGN KEY ("facility_id","recorded_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_allergies" ADD CONSTRAINT "patient_allergies_removed_by_fk" FOREIGN KEY ("facility_id","removed_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "observations_encounter_index" ON "observations" USING btree ("facility_id","encounter_id","observed_at");--> statement-breakpoint
CREATE INDEX "patient_allergies_patient_index" ON "patient_allergies" USING btree ("facility_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_allergies_one_none_known" ON "patient_allergies" USING btree ("patient_id") WHERE "patient_allergies"."category" = 'none_known' AND "patient_allergies"."removed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_known" CHECK ("audit_log"."action" IN ('facility.created', 'invitation.created', 'invitation.revoked', 'membership.granted', 'membership.roles_changed', 'membership.revoked', 'membership.licence_changed', 'document.issued', 'document.voided', 'document.viewed', 'document.verified', 'patient.registered', 'patient.updated', 'patient.identifier_added', 'patient.viewed', 'patient.searched', 'encounter.opened', 'encounter.closed', 'encounter.cancelled', 'encounter.viewed', 'patient.admitted', 'patient.transferred', 'patient.discharged', 'ward.created', 'bed.created', 'billable_item.created', 'price_change.requested', 'price_change.approved', 'price_change.rejected', 'price_change.withdrawn', 'ward.bed_day_item_set', 'charge.posted', 'charge.accrued', 'charge.cancelled', 'invoice.drafted', 'invoice.finalised', 'invoice.voided', 'invoice.viewed', 'adjustment.requested', 'adjustment.approved', 'adjustment.rejected', 'adjustment.withdrawn', 'adjustment.listed', 'shift.opened', 'shift.closed', 'payment.recorded', 'payment.reversed', 'allocation.recorded', 'allocation.reversed', 'account.viewed', 'payment.viewed', 'refund.requested', 'refund.approved', 'refund.rejected', 'refund.withdrawn', 'refund.paid', 'refund.reversed', 'refund.listed', 'mpesa.settings_changed', 'mpesa.received', 'mpesa.assigned', 'mpesa.rejected', 'mpesa.listed', 'mpesa.stk_requested', 'mpesa.stk_viewed', 'adjustment.reversal_requested', 'adjustment.reversed', 'adjustment.reversal_rejected', 'adjustment.reversal_withdrawn', 'adjustment.reversals_listed', 'service_point.created', 'service_point.updated', 'queue.joined', 'queue.served', 'queue.finished', 'queue.removed', 'queue.viewed', 'charge.captured', 'billing.due_listed', 'observation.recorded', 'observation.entered_in_error', 'allergy.recorded', 'allergy.removed'));--> statement-breakpoint
ALTER TABLE "queue_entries" ADD CONSTRAINT "queue_entries_priority_known" CHECK ("queue_entries"."priority" IN ('emergency', 'urgent', 'routine'));--> statement-breakpoint
ALTER TABLE "queue_entries" ADD CONSTRAINT "queue_entries_priority_when_done" CHECK ("queue_entries"."priority" IS NULL OR "queue_entries"."status" = 'done');