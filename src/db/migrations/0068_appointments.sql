CREATE TABLE "appointment_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"reminds_of" date NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"to_phone" text,
	"body" text,
	"sending_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"provider_message_id" text,
	"cost_cents" integer,
	"outcome_note" text,
	CONSTRAINT "appointment_reminders_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "appointment_reminders_one_per_day" UNIQUE("appointment_id","reminds_of"),
	CONSTRAINT "appointment_reminders_status_known" CHECK ("appointment_reminders"."status" IN ('scheduled', 'sending', 'sent', 'rejected', 'failed', 'skipped')),
	CONSTRAINT "appointment_reminders_kenyan_mobile" CHECK ("appointment_reminders"."to_phone" IS NULL OR "appointment_reminders"."to_phone" ~ '^\+254[17][0-9]{8}$'),
	CONSTRAINT "appointment_reminders_cost_nonnegative" CHECK ("appointment_reminders"."cost_cents" IS NULL OR "appointment_reminders"."cost_cents" >= 0),
	CONSTRAINT "appointment_reminders_lifecycle" CHECK (("appointment_reminders"."status" = 'scheduled'
          AND num_nonnulls("appointment_reminders"."to_phone", "appointment_reminders"."body", "appointment_reminders"."sending_at", "appointment_reminders"."completed_at", "appointment_reminders"."provider_message_id", "appointment_reminders"."cost_cents", "appointment_reminders"."outcome_note") = 0)
      OR ("appointment_reminders"."status" = 'sending'
          AND num_nonnulls("appointment_reminders"."to_phone", "appointment_reminders"."body", "appointment_reminders"."sending_at") = 3
          AND num_nonnulls("appointment_reminders"."completed_at", "appointment_reminders"."provider_message_id", "appointment_reminders"."cost_cents", "appointment_reminders"."outcome_note") = 0)
      OR ("appointment_reminders"."status" = 'sent'
          AND num_nonnulls("appointment_reminders"."to_phone", "appointment_reminders"."body", "appointment_reminders"."sending_at", "appointment_reminders"."completed_at") = 4 AND "appointment_reminders"."outcome_note" IS NULL)
      OR ("appointment_reminders"."status" = 'rejected'
          AND num_nonnulls("appointment_reminders"."to_phone", "appointment_reminders"."body", "appointment_reminders"."sending_at", "appointment_reminders"."completed_at", "appointment_reminders"."outcome_note") = 5)
      OR ("appointment_reminders"."status" IN ('failed', 'skipped')
          AND num_nonnulls("appointment_reminders"."completed_at", "appointment_reminders"."outcome_note") = 2
          AND num_nonnulls("appointment_reminders"."provider_message_id", "appointment_reminders"."cost_cents") = 0
          AND ("appointment_reminders"."to_phone" IS NULL) = ("appointment_reminders"."sending_at" IS NULL) AND ("appointment_reminders"."body" IS NULL) = ("appointment_reminders"."sending_at" IS NULL))),
	CONSTRAINT "appointment_reminders_note_present" CHECK ("appointment_reminders"."outcome_note" IS NULL OR length(btrim("appointment_reminders"."outcome_note")) > 0)
);
--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"service_point_id" uuid NOT NULL,
	"clinician_id" uuid,
	"scheduled_on" date NOT NULL,
	"scheduled_time" time(0),
	"status" text DEFAULT 'booked' NOT NULL,
	"booked_at" timestamp with time zone NOT NULL,
	"booked_by" uuid NOT NULL,
	"booked_during" uuid,
	"checked_in_at" timestamp with time zone,
	"checked_in_by" uuid,
	"encounter_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointments_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "appointments_status_known" CHECK ("appointments"."status" IN ('booked', 'checked_in', 'cancelled')),
	CONSTRAINT "appointments_lifecycle" CHECK (("appointments"."status" = 'booked'
          AND num_nonnulls("appointments"."checked_in_at", "appointments"."checked_in_by", "appointments"."encounter_id", "appointments"."cancelled_at", "appointments"."cancelled_by", "appointments"."cancel_reason") = 0)
      OR ("appointments"."status" = 'checked_in'
          AND num_nonnulls("appointments"."checked_in_at", "appointments"."checked_in_by", "appointments"."encounter_id") = 3
          AND num_nonnulls("appointments"."cancelled_at", "appointments"."cancelled_by", "appointments"."cancel_reason") = 0)
      OR ("appointments"."status" = 'cancelled'
          AND num_nonnulls("appointments"."cancelled_at", "appointments"."cancelled_by", "appointments"."cancel_reason") = 3
          AND num_nonnulls("appointments"."checked_in_at", "appointments"."checked_in_by", "appointments"."encounter_id") = 0)),
	CONSTRAINT "appointments_cancel_reason_present" CHECK ("appointments"."cancel_reason" IS NULL OR length(btrim("appointments"."cancel_reason")) > 0),
	CONSTRAINT "appointments_in_order" CHECK (("appointments"."checked_in_at" IS NULL OR "appointments"."checked_in_at" >= "appointments"."booked_at")
      AND ("appointments"."cancelled_at" IS NULL OR "appointments"."cancelled_at" >= "appointments"."booked_at"))
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_known";--> statement-breakpoint
ALTER TABLE "outbox" DROP CONSTRAINT "outbox_operation_known";--> statement-breakpoint
ALTER TABLE "facilities" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "facilities" ADD COLUMN "sms_sender_id" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "sms_reminders" boolean;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "sms_reminders_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "sms_reminders_set_by" uuid;--> statement-breakpoint
ALTER TABLE "appointment_reminders" ADD CONSTRAINT "appointment_reminders_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_reminders" ADD CONSTRAINT "appointment_reminders_appointment_fk" FOREIGN KEY ("facility_id","appointment_id") REFERENCES "public"."appointments"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patient_fk" FOREIGN KEY ("facility_id","patient_id") REFERENCES "public"."patients"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_service_point_fk" FOREIGN KEY ("facility_id","service_point_id") REFERENCES "public"."service_points"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_clinician_fk" FOREIGN KEY ("facility_id","clinician_id") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_booked_by_fk" FOREIGN KEY ("facility_id","booked_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_booked_during_fk" FOREIGN KEY ("facility_id","booked_during") REFERENCES "public"."encounters"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_checked_in_by_fk" FOREIGN KEY ("facility_id","checked_in_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_encounter_fk" FOREIGN KEY ("facility_id","encounter_id") REFERENCES "public"."encounters"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_cancelled_by_fk" FOREIGN KEY ("facility_id","cancelled_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_reminders_facility_index" ON "appointment_reminders" USING btree ("facility_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_one_booked_per_clinic_day" ON "appointments" USING btree ("patient_id","service_point_id","scheduled_on") WHERE "appointments"."status" = 'booked';--> statement-breakpoint
CREATE INDEX "appointments_day_index" ON "appointments" USING btree ("facility_id","scheduled_on","service_point_id");--> statement-breakpoint
CREATE INDEX "appointments_patient_index" ON "appointments" USING btree ("facility_id","patient_id","scheduled_on");--> statement-breakpoint
CREATE INDEX "appointments_booked_at_clinic_index" ON "appointments" USING btree ("facility_id","service_point_id","scheduled_on") WHERE "appointments"."status" = 'booked';--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_sms_reminders_set_by_fk" FOREIGN KEY ("facility_id","sms_reminders_set_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_known" CHECK ("audit_log"."action" IN ('facility.created', 'invitation.created', 'invitation.revoked', 'membership.granted', 'membership.roles_changed', 'membership.revoked', 'membership.licence_changed', 'document.issued', 'document.voided', 'document.viewed', 'document.verified', 'patient.registered', 'patient.updated', 'patient.identifier_added', 'patient.viewed', 'patient.searched', 'encounter.opened', 'encounter.closed', 'encounter.cancelled', 'encounter.viewed', 'patient.admitted', 'patient.transferred', 'patient.discharged', 'ward.created', 'bed.created', 'billable_item.created', 'price_change.requested', 'price_change.approved', 'price_change.rejected', 'price_change.withdrawn', 'ward.bed_day_item_set', 'charge.posted', 'charge.accrued', 'charge.cancelled', 'invoice.drafted', 'invoice.finalised', 'invoice.voided', 'invoice.viewed', 'adjustment.requested', 'adjustment.approved', 'adjustment.rejected', 'adjustment.withdrawn', 'adjustment.listed', 'shift.opened', 'shift.closed', 'payment.recorded', 'payment.reversed', 'allocation.recorded', 'allocation.reversed', 'account.viewed', 'payment.viewed', 'refund.requested', 'refund.approved', 'refund.rejected', 'refund.withdrawn', 'refund.paid', 'refund.reversed', 'refund.listed', 'mpesa.settings_changed', 'mpesa.received', 'mpesa.assigned', 'mpesa.rejected', 'mpesa.listed', 'mpesa.stk_requested', 'mpesa.stk_viewed', 'adjustment.reversal_requested', 'adjustment.reversed', 'adjustment.reversal_rejected', 'adjustment.reversal_withdrawn', 'adjustment.reversals_listed', 'service_point.created', 'service_point.updated', 'queue.joined', 'queue.served', 'queue.finished', 'queue.removed', 'queue.viewed', 'charge.captured', 'billing.due_listed', 'observation.recorded', 'observation.entered_in_error', 'allergy.recorded', 'allergy.removed', 'diagnosis.recorded', 'diagnosis.confirmed', 'diagnosis.principal_set', 'diagnosis.ended', 'note.drafted', 'note.edited', 'note.signed', 'note.discarded', 'note.addendum_added', 'note.entered_in_error', 'lab_test.created', 'lab_test.updated', 'lab_analyte.added', 'lab_analyte.updated', 'lab_analyte.ranges_set', 'order.placed', 'order_item.cancelled', 'order_item.done', 'prescription.issued', 'prescription.cancelled', 'prescription.allergy_overridden', 'specimen.collected', 'specimen.received', 'specimen.rejected', 'lab.worklist_viewed', 'lab_result.entered', 'lab_result.released', 'lab_result.verified', 'lab_report.issued', 'appointment.booked', 'appointment.moved', 'appointment.cancelled', 'appointment.checked_in', 'appointment.listed', 'patient.sms_reminders_set', 'facility.updated'));--> statement-breakpoint
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_phone_e164" CHECK ("facilities"."phone" IS NULL OR "facilities"."phone" ~ '^\+[1-9][0-9]{7,14}$');--> statement-breakpoint
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_sms_sender_id_shape" CHECK ("facilities"."sms_sender_id" IS NULL OR "facilities"."sms_sender_id" ~ '^[A-Za-z0-9][A-Za-z0-9 ]{0,10}$');--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_operation_known" CHECK ("outbox"."operation" IN ('invitation.send', 'mpesa.register_urls', 'mpesa.stk_push', 'appointment.remind'));--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_sms_reminders_recorded" CHECK (num_nonnulls("patients"."sms_reminders", "patients"."sms_reminders_set_at", "patients"."sms_reminders_set_by") IN (0, 3));