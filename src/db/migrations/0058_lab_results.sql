CREATE TABLE "lab_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	CONSTRAINT "lab_reports_document_key" UNIQUE("document_id")
);
--> statement-breakpoint
CREATE TABLE "lab_result_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"result_id" uuid NOT NULL,
	"analyte_id" uuid NOT NULL,
	"analyte_code" text NOT NULL,
	"analyte_name" text NOT NULL,
	"result_type" text NOT NULL,
	"unit" text,
	"value_numeric" numeric,
	"value_text" text,
	"range_low" numeric,
	"range_high" numeric,
	"critical_low" numeric,
	"critical_high" numeric,
	"flag" text,
	CONSTRAINT "lab_result_values_result_analyte_key" UNIQUE("result_id","analyte_id"),
	CONSTRAINT "lab_result_values_result_type_known" CHECK ("lab_result_values"."result_type" IN ('numeric', 'choice', 'text')),
	CONSTRAINT "lab_result_values_flag_known" CHECK ("lab_result_values"."flag" IN ('low', 'high', 'critical_low', 'critical_high', 'abnormal')),
	CONSTRAINT "lab_result_values_shape" CHECK (("lab_result_values"."result_type" = 'numeric' AND "lab_result_values"."value_numeric" IS NOT NULL AND "lab_result_values"."value_text" IS NULL)
      OR ("lab_result_values"."result_type" <> 'numeric' AND "lab_result_values"."value_text" IS NOT NULL AND length(btrim("lab_result_values"."value_text")) > 0
          AND num_nonnulls("lab_result_values"."value_numeric", "lab_result_values"."unit", "lab_result_values"."range_low", "lab_result_values"."range_high", "lab_result_values"."critical_low", "lab_result_values"."critical_high") = 0
          AND ("lab_result_values"."flag" IS NULL OR "lab_result_values"."flag" = 'abnormal')))
);
--> statement-breakpoint
CREATE TABLE "lab_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"specimen_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"correction_reason" text,
	"status" text NOT NULL,
	"entered_at" timestamp with time zone NOT NULL,
	"entered_by" uuid NOT NULL,
	"has_critical" boolean NOT NULL,
	"released_at" timestamp with time zone,
	"released_by" uuid,
	"release_reason" text,
	"verified_at" timestamp with time zone,
	"verified_by" uuid,
	"told_name" text,
	"told_how" text,
	"told_at" timestamp with time zone,
	"told_recorded_by" uuid,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "lab_results_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "lab_results_version_key" UNIQUE("specimen_id","order_item_id","version"),
	CONSTRAINT "lab_results_status_known" CHECK ("lab_results"."status" IN ('entered', 'released', 'verified', 'superseded')),
	CONSTRAINT "lab_results_told_how_known" CHECK ("lab_results"."told_how" IN ('in_person', 'phone')),
	CONSTRAINT "lab_results_version_positive" CHECK ("lab_results"."version" >= 1),
	CONSTRAINT "lab_results_correction_reason" CHECK (("lab_results"."version" = 1) = ("lab_results"."correction_reason" IS NULL)
      AND ("lab_results"."correction_reason" IS NULL OR length(btrim("lab_results"."correction_reason")) > 0)),
	CONSTRAINT "lab_results_lifecycle" CHECK (num_nonnulls("lab_results"."released_at", "lab_results"."released_by", "lab_results"."release_reason") IN (0, 3)
      AND num_nonnulls("lab_results"."verified_at", "lab_results"."verified_by") IN (0, 2)
      AND ("lab_results"."release_reason" IS NULL OR length(btrim("lab_results"."release_reason")) > 0)
      AND CASE "lab_results"."status"
            WHEN 'entered' THEN num_nonnulls("lab_results"."released_at", "lab_results"."verified_at", "lab_results"."superseded_at") = 0
            WHEN 'released' THEN "lab_results"."released_at" IS NOT NULL AND num_nonnulls("lab_results"."verified_at", "lab_results"."superseded_at") = 0
            WHEN 'verified' THEN "lab_results"."verified_at" IS NOT NULL AND "lab_results"."superseded_at" IS NULL
            ELSE "lab_results"."superseded_at" IS NOT NULL
          END),
	CONSTRAINT "lab_results_verified_by_another" CHECK ("lab_results"."verified_by" IS NULL OR "lab_results"."verified_by" <> "lab_results"."entered_by"),
	CONSTRAINT "lab_results_told" CHECK (num_nonnulls("lab_results"."told_name", "lab_results"."told_how", "lab_results"."told_at", "lab_results"."told_recorded_by") IN (0, 4)
      AND ("lab_results"."told_name" IS NULL OR length(btrim("lab_results"."told_name")) > 0)
      AND (NOT "lab_results"."has_critical" OR "lab_results"."released_at" IS NULL AND "lab_results"."verified_at" IS NULL OR "lab_results"."told_name" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_known";--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_kind_known";--> statement-breakpoint
ALTER TABLE "job_failures" DROP CONSTRAINT "job_failures_job_known";--> statement-breakpoint
ALTER TABLE "number_series" DROP CONSTRAINT "number_series_kind_known";--> statement-breakpoint
ALTER TABLE "lab_reports" ADD CONSTRAINT "lab_reports_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_reports" ADD CONSTRAINT "lab_reports_order_fk" FOREIGN KEY ("facility_id","order_id") REFERENCES "public"."orders"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_reports" ADD CONSTRAINT "lab_reports_document_fk" FOREIGN KEY ("facility_id","document_id") REFERENCES "public"."documents"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_result_values" ADD CONSTRAINT "lab_result_values_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_result_values" ADD CONSTRAINT "lab_result_values_result_fk" FOREIGN KEY ("facility_id","result_id") REFERENCES "public"."lab_results"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_result_values" ADD CONSTRAINT "lab_result_values_analyte_fk" FOREIGN KEY ("facility_id","analyte_id") REFERENCES "public"."lab_analytes"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_specimen_fk" FOREIGN KEY ("facility_id","specimen_id") REFERENCES "public"."specimens"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_order_item_fk" FOREIGN KEY ("facility_id","order_item_id") REFERENCES "public"."order_items"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_entered_by_fk" FOREIGN KEY ("facility_id","entered_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_released_by_fk" FOREIGN KEY ("facility_id","released_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_verified_by_fk" FOREIGN KEY ("facility_id","verified_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_told_recorded_by_fk" FOREIGN KEY ("facility_id","told_recorded_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lab_reports_order_index" ON "lab_reports" USING btree ("facility_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_results_one_current" ON "lab_results" USING btree ("specimen_id","order_item_id") WHERE "lab_results"."status" <> 'superseded';--> statement-breakpoint
CREATE INDEX "lab_results_order_item_index" ON "lab_results" USING btree ("facility_id","order_item_id");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_known" CHECK ("audit_log"."action" IN ('facility.created', 'invitation.created', 'invitation.revoked', 'membership.granted', 'membership.roles_changed', 'membership.revoked', 'membership.licence_changed', 'document.issued', 'document.voided', 'document.viewed', 'document.verified', 'patient.registered', 'patient.updated', 'patient.identifier_added', 'patient.viewed', 'patient.searched', 'encounter.opened', 'encounter.closed', 'encounter.cancelled', 'encounter.viewed', 'patient.admitted', 'patient.transferred', 'patient.discharged', 'ward.created', 'bed.created', 'billable_item.created', 'price_change.requested', 'price_change.approved', 'price_change.rejected', 'price_change.withdrawn', 'ward.bed_day_item_set', 'charge.posted', 'charge.accrued', 'charge.cancelled', 'invoice.drafted', 'invoice.finalised', 'invoice.voided', 'invoice.viewed', 'adjustment.requested', 'adjustment.approved', 'adjustment.rejected', 'adjustment.withdrawn', 'adjustment.listed', 'shift.opened', 'shift.closed', 'payment.recorded', 'payment.reversed', 'allocation.recorded', 'allocation.reversed', 'account.viewed', 'payment.viewed', 'refund.requested', 'refund.approved', 'refund.rejected', 'refund.withdrawn', 'refund.paid', 'refund.reversed', 'refund.listed', 'mpesa.settings_changed', 'mpesa.received', 'mpesa.assigned', 'mpesa.rejected', 'mpesa.listed', 'mpesa.stk_requested', 'mpesa.stk_viewed', 'adjustment.reversal_requested', 'adjustment.reversed', 'adjustment.reversal_rejected', 'adjustment.reversal_withdrawn', 'adjustment.reversals_listed', 'service_point.created', 'service_point.updated', 'queue.joined', 'queue.served', 'queue.finished', 'queue.removed', 'queue.viewed', 'charge.captured', 'billing.due_listed', 'observation.recorded', 'observation.entered_in_error', 'allergy.recorded', 'allergy.removed', 'diagnosis.recorded', 'diagnosis.confirmed', 'diagnosis.principal_set', 'diagnosis.ended', 'note.drafted', 'note.edited', 'note.signed', 'note.discarded', 'note.addendum_added', 'note.entered_in_error', 'lab_test.created', 'lab_test.updated', 'lab_analyte.added', 'lab_analyte.updated', 'lab_analyte.ranges_set', 'order.placed', 'order_item.cancelled', 'order_item.done', 'prescription.issued', 'prescription.cancelled', 'prescription.allergy_overridden', 'specimen.collected', 'specimen.received', 'specimen.rejected', 'lab.worklist_viewed', 'lab_result.entered', 'lab_result.released', 'lab_result.verified', 'lab_report.issued'));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_kind_known" CHECK ("documents"."kind" IN ('receipt', 'invoice', 'credit_note', 'refund', 'prescription', 'lab_report'));--> statement-breakpoint
ALTER TABLE "job_failures" ADD CONSTRAINT "job_failures_job_known" CHECK ("job_failures"."job" IN ('bed_day_accrual', 'reconciliation', 'visit_close', 'visit_finish'));--> statement-breakpoint
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_kind_known" CHECK ("number_series"."kind" IN ('outpatient', 'inpatient', 'admission', 'receipt', 'invoice', 'credit_note', 'refund', 'prescription', 'lab_accession', 'lab_report'));