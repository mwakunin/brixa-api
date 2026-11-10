CREATE TABLE "diagnoses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"icd_code" text NOT NULL,
	"icd_title" text NOT NULL,
	"icd_uri" text NOT NULL,
	"icd_release" text NOT NULL,
	"certainty" text NOT NULL,
	"rank" text NOT NULL,
	"diagnosed_at" timestamp with time zone NOT NULL,
	"diagnosed_by" uuid NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	"ended_at" timestamp with time zone,
	"ended_by" uuid,
	"end_reason" text,
	CONSTRAINT "diagnoses_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "diagnoses_certainty_known" CHECK ("diagnoses"."certainty" IN ('provisional', 'confirmed')),
	CONSTRAINT "diagnoses_rank_known" CHECK ("diagnoses"."rank" IN ('principal', 'secondary')),
	CONSTRAINT "diagnoses_end_reason_known" CHECK ("diagnoses"."end_reason" IN ('ruled_out', 'entered_in_error')),
	CONSTRAINT "diagnoses_confirmation" CHECK (("diagnoses"."confirmed_at" IS NULL AND "diagnoses"."confirmed_by" IS NULL)
      OR ("diagnoses"."confirmed_at" IS NOT NULL AND "diagnoses"."confirmed_by" IS NOT NULL AND "diagnoses"."certainty" = 'confirmed')),
	CONSTRAINT "diagnoses_end_complete" CHECK (("diagnoses"."ended_at" IS NULL AND "diagnoses"."ended_by" IS NULL AND "diagnoses"."end_reason" IS NULL)
      OR ("diagnoses"."ended_at" IS NOT NULL AND "diagnoses"."ended_by" IS NOT NULL AND "diagnoses"."end_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "icd_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"uri" text NOT NULL,
	"chapter" text NOT NULL,
	"is_leaf" boolean NOT NULL,
	"is_residual" boolean NOT NULL,
	"release" text NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "icd_codes_code_shape" CHECK ("icd_codes"."code" ~ '^[0-9A-Z]{4}(\.[0-9A-Z]{1,2})*$'),
	CONSTRAINT "icd_codes_chapter_shape" CHECK ("icd_codes"."chapter" ~ '^(0[1-9]|1[0-9]|2[0-5])$'),
	CONSTRAINT "icd_codes_release_shape" CHECK ("icd_codes"."release" ~ '^[0-9]{4}-[0-9]{2}$'),
	CONSTRAINT "icd_codes_uri_shape" CHECK ("icd_codes"."uri" LIKE 'http://id.who.int/icd/release/11/%')
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_known";--> statement-breakpoint
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_icd_code_icd_codes_code_fk" FOREIGN KEY ("icd_code") REFERENCES "public"."icd_codes"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_encounter_fk" FOREIGN KEY ("facility_id","encounter_id") REFERENCES "public"."encounters"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_diagnosed_by_fk" FOREIGN KEY ("facility_id","diagnosed_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_confirmed_by_fk" FOREIGN KEY ("facility_id","confirmed_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_ended_by_fk" FOREIGN KEY ("facility_id","ended_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "diagnoses_encounter_index" ON "diagnoses" USING btree ("facility_id","encounter_id","diagnosed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "diagnoses_one_standing_principal" ON "diagnoses" USING btree ("encounter_id") WHERE "diagnoses"."rank" = 'principal' AND "diagnoses"."ended_at" IS NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_known" CHECK ("audit_log"."action" IN ('facility.created', 'invitation.created', 'invitation.revoked', 'membership.granted', 'membership.roles_changed', 'membership.revoked', 'membership.licence_changed', 'document.issued', 'document.voided', 'document.viewed', 'document.verified', 'patient.registered', 'patient.updated', 'patient.identifier_added', 'patient.viewed', 'patient.searched', 'encounter.opened', 'encounter.closed', 'encounter.cancelled', 'encounter.viewed', 'patient.admitted', 'patient.transferred', 'patient.discharged', 'ward.created', 'bed.created', 'billable_item.created', 'price_change.requested', 'price_change.approved', 'price_change.rejected', 'price_change.withdrawn', 'ward.bed_day_item_set', 'charge.posted', 'charge.accrued', 'charge.cancelled', 'invoice.drafted', 'invoice.finalised', 'invoice.voided', 'invoice.viewed', 'adjustment.requested', 'adjustment.approved', 'adjustment.rejected', 'adjustment.withdrawn', 'adjustment.listed', 'shift.opened', 'shift.closed', 'payment.recorded', 'payment.reversed', 'allocation.recorded', 'allocation.reversed', 'account.viewed', 'payment.viewed', 'refund.requested', 'refund.approved', 'refund.rejected', 'refund.withdrawn', 'refund.paid', 'refund.reversed', 'refund.listed', 'mpesa.settings_changed', 'mpesa.received', 'mpesa.assigned', 'mpesa.rejected', 'mpesa.listed', 'mpesa.stk_requested', 'mpesa.stk_viewed', 'adjustment.reversal_requested', 'adjustment.reversed', 'adjustment.reversal_rejected', 'adjustment.reversal_withdrawn', 'adjustment.reversals_listed', 'service_point.created', 'service_point.updated', 'queue.joined', 'queue.served', 'queue.finished', 'queue.removed', 'queue.viewed', 'charge.captured', 'billing.due_listed', 'observation.recorded', 'observation.entered_in_error', 'allergy.recorded', 'allergy.removed', 'diagnosis.recorded', 'diagnosis.confirmed', 'diagnosis.principal_set', 'diagnosis.ended'));