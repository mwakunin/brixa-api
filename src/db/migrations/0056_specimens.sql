CREATE TABLE "specimen_tests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"specimen_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	CONSTRAINT "specimen_tests_specimen_item_key" UNIQUE("specimen_id","order_item_id")
);
--> statement-breakpoint
CREATE TABLE "specimens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"accession_number" text NOT NULL,
	"specimen_type" text NOT NULL,
	"status" text NOT NULL,
	"collected_at" timestamp with time zone NOT NULL,
	"collected_by" uuid NOT NULL,
	"received_at" timestamp with time zone,
	"received_by" uuid,
	"rejected_at" timestamp with time zone,
	"rejected_by" uuid,
	"rejection_reason" text,
	"rejection_note" text,
	"recollection_of" uuid,
	CONSTRAINT "specimens_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "specimens_facility_id_accession_number_key" UNIQUE("facility_id","accession_number"),
	CONSTRAINT "specimens_specimen_type_known" CHECK ("specimens"."specimen_type" IN ('blood', 'urine', 'stool', 'sputum', 'swab', 'csf', 'body_fluid', 'other')),
	CONSTRAINT "specimens_status_known" CHECK ("specimens"."status" IN ('collected', 'received', 'rejected')),
	CONSTRAINT "specimens_rejection_reason_known" CHECK ("specimens"."rejection_reason" IN ('haemolysed', 'clotted', 'insufficient', 'wrong_container', 'mislabelled', 'leaked', 'too_old', 'other')),
	CONSTRAINT "specimens_lifecycle" CHECK (("specimens"."status" = 'collected' AND num_nonnulls("specimens"."received_at", "specimens"."received_by", "specimens"."rejected_at", "specimens"."rejected_by", "specimens"."rejection_reason", "specimens"."rejection_note") = 0)
      OR ("specimens"."status" = 'received' AND "specimens"."received_at" IS NOT NULL AND "specimens"."received_by" IS NOT NULL
          AND num_nonnulls("specimens"."rejected_at", "specimens"."rejected_by", "specimens"."rejection_reason", "specimens"."rejection_note") = 0)
      OR ("specimens"."status" = 'rejected' AND "specimens"."rejected_at" IS NOT NULL AND "specimens"."rejected_by" IS NOT NULL AND "specimens"."rejection_reason" IS NOT NULL
          AND ("specimens"."received_at" IS NULL) = ("specimens"."received_by" IS NULL))),
	CONSTRAINT "specimens_rejection_note" CHECK (("specimens"."rejection_note" IS NULL OR length(btrim("specimens"."rejection_note")) > 0)
      AND ("specimens"."rejection_reason" IS DISTINCT FROM 'other' OR "specimens"."rejection_note" IS NOT NULL)),
	CONSTRAINT "specimens_in_order" CHECK (("specimens"."received_at" IS NULL OR "specimens"."received_at" >= "specimens"."collected_at")
      AND ("specimens"."rejected_at" IS NULL OR "specimens"."rejected_at" >= "specimens"."collected_at"))
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_known";--> statement-breakpoint
ALTER TABLE "number_series" DROP CONSTRAINT "number_series_kind_known";--> statement-breakpoint
ALTER TABLE "specimen_tests" ADD CONSTRAINT "specimen_tests_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specimen_tests" ADD CONSTRAINT "specimen_tests_specimen_fk" FOREIGN KEY ("facility_id","specimen_id") REFERENCES "public"."specimens"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specimen_tests" ADD CONSTRAINT "specimen_tests_order_item_fk" FOREIGN KEY ("facility_id","order_item_id") REFERENCES "public"."order_items"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specimens" ADD CONSTRAINT "specimens_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specimens" ADD CONSTRAINT "specimens_order_fk" FOREIGN KEY ("facility_id","order_id") REFERENCES "public"."orders"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specimens" ADD CONSTRAINT "specimens_collected_by_fk" FOREIGN KEY ("facility_id","collected_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specimens" ADD CONSTRAINT "specimens_received_by_fk" FOREIGN KEY ("facility_id","received_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specimens" ADD CONSTRAINT "specimens_rejected_by_fk" FOREIGN KEY ("facility_id","rejected_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specimens" ADD CONSTRAINT "specimens_recollection_of_fk" FOREIGN KEY ("facility_id","recollection_of") REFERENCES "public"."specimens"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "specimen_tests_order_item_index" ON "specimen_tests" USING btree ("facility_id","order_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "specimens_recollected_once" ON "specimens" USING btree ("recollection_of") WHERE "specimens"."recollection_of" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "specimens_order_index" ON "specimens" USING btree ("facility_id","order_id");--> statement-breakpoint
CREATE INDEX "specimens_in_lab_index" ON "specimens" USING btree ("facility_id","collected_at") WHERE "specimens"."status" IN ('collected', 'received');--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_known" CHECK ("audit_log"."action" IN ('facility.created', 'invitation.created', 'invitation.revoked', 'membership.granted', 'membership.roles_changed', 'membership.revoked', 'membership.licence_changed', 'document.issued', 'document.voided', 'document.viewed', 'document.verified', 'patient.registered', 'patient.updated', 'patient.identifier_added', 'patient.viewed', 'patient.searched', 'encounter.opened', 'encounter.closed', 'encounter.cancelled', 'encounter.viewed', 'patient.admitted', 'patient.transferred', 'patient.discharged', 'ward.created', 'bed.created', 'billable_item.created', 'price_change.requested', 'price_change.approved', 'price_change.rejected', 'price_change.withdrawn', 'ward.bed_day_item_set', 'charge.posted', 'charge.accrued', 'charge.cancelled', 'invoice.drafted', 'invoice.finalised', 'invoice.voided', 'invoice.viewed', 'adjustment.requested', 'adjustment.approved', 'adjustment.rejected', 'adjustment.withdrawn', 'adjustment.listed', 'shift.opened', 'shift.closed', 'payment.recorded', 'payment.reversed', 'allocation.recorded', 'allocation.reversed', 'account.viewed', 'payment.viewed', 'refund.requested', 'refund.approved', 'refund.rejected', 'refund.withdrawn', 'refund.paid', 'refund.reversed', 'refund.listed', 'mpesa.settings_changed', 'mpesa.received', 'mpesa.assigned', 'mpesa.rejected', 'mpesa.listed', 'mpesa.stk_requested', 'mpesa.stk_viewed', 'adjustment.reversal_requested', 'adjustment.reversed', 'adjustment.reversal_rejected', 'adjustment.reversal_withdrawn', 'adjustment.reversals_listed', 'service_point.created', 'service_point.updated', 'queue.joined', 'queue.served', 'queue.finished', 'queue.removed', 'queue.viewed', 'charge.captured', 'billing.due_listed', 'observation.recorded', 'observation.entered_in_error', 'allergy.recorded', 'allergy.removed', 'diagnosis.recorded', 'diagnosis.confirmed', 'diagnosis.principal_set', 'diagnosis.ended', 'note.drafted', 'note.edited', 'note.signed', 'note.discarded', 'note.addendum_added', 'note.entered_in_error', 'lab_test.created', 'lab_test.updated', 'lab_analyte.added', 'lab_analyte.updated', 'lab_analyte.ranges_set', 'order.placed', 'order_item.cancelled', 'order_item.done', 'prescription.issued', 'prescription.cancelled', 'prescription.allergy_overridden', 'specimen.collected', 'specimen.received', 'specimen.rejected', 'lab.worklist_viewed'));--> statement-breakpoint
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_kind_known" CHECK ("number_series"."kind" IN ('outpatient', 'inpatient', 'admission', 'receipt', 'invoice', 'credit_note', 'refund', 'prescription', 'lab_accession'));