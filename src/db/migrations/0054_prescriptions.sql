CREATE TABLE "drug_catalogue" (
	"code" text PRIMARY KEY NOT NULL,
	"generic_name" text NOT NULL,
	"strength" text NOT NULL,
	"form" text NOT NULL,
	"dose_unit" text NOT NULL,
	"route" text NOT NULL,
	"controlled_schedule" text,
	"loaded_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "drug_catalogue_code_shape" CHECK ("drug_catalogue"."code" ~ '^[A-Z0-9][A-Z0-9._/-]{0,31}$'),
	CONSTRAINT "drug_catalogue_text_present" CHECK (length(btrim("drug_catalogue"."generic_name")) > 0 AND length(btrim("drug_catalogue"."strength")) > 0
      AND length(btrim("drug_catalogue"."form")) > 0 AND length(btrim("drug_catalogue"."dose_unit")) > 0),
	CONSTRAINT "drug_catalogue_route_known" CHECK ("drug_catalogue"."route" IN ('oral', 'sublingual', 'iv', 'im', 'sc', 'intradermal', 'topical', 'rectal', 'vaginal', 'inhaled', 'nasal', 'ophthalmic', 'otic')),
	CONSTRAINT "drug_catalogue_controlled_schedule_known" CHECK ("drug_catalogue"."controlled_schedule" IN ('I', 'II', 'III', 'IV'))
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_known";--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_kind_known";--> statement-breakpoint
ALTER TABLE "lab_analytes" DROP CONSTRAINT "lab_analytes_shape";--> statement-breakpoint
ALTER TABLE "number_series" DROP CONSTRAINT "number_series_kind_known";--> statement-breakpoint
ALTER TABLE "order_items" DROP CONSTRAINT "order_items_one_kind";--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "drug_code" text;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "drug_description" text;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "dose_amount" numeric(11, 3);--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "dose_unit" text;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "route" text;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "frequency" text;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "duration_days" integer;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "quantity" numeric(11, 3);--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "instructions" text;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "allergy_override_reason" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "patient_allergies" ADD COLUMN "drug_code" text;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_drug_fk" FOREIGN KEY ("drug_code") REFERENCES "public"."drug_catalogue"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_document_fk" FOREIGN KEY ("facility_id","document_id") REFERENCES "public"."documents"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_allergies" ADD CONSTRAINT "patient_allergies_drug_code_drug_catalogue_code_fk" FOREIGN KEY ("drug_code") REFERENCES "public"."drug_catalogue"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_items_drug_once" ON "order_items" USING btree ("order_id","drug_code") WHERE "order_items"."drug_code" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_one_per_document" ON "orders" USING btree ("document_id") WHERE "orders"."document_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_known" CHECK ("audit_log"."action" IN ('facility.created', 'invitation.created', 'invitation.revoked', 'membership.granted', 'membership.roles_changed', 'membership.revoked', 'membership.licence_changed', 'document.issued', 'document.voided', 'document.viewed', 'document.verified', 'patient.registered', 'patient.updated', 'patient.identifier_added', 'patient.viewed', 'patient.searched', 'encounter.opened', 'encounter.closed', 'encounter.cancelled', 'encounter.viewed', 'patient.admitted', 'patient.transferred', 'patient.discharged', 'ward.created', 'bed.created', 'billable_item.created', 'price_change.requested', 'price_change.approved', 'price_change.rejected', 'price_change.withdrawn', 'ward.bed_day_item_set', 'charge.posted', 'charge.accrued', 'charge.cancelled', 'invoice.drafted', 'invoice.finalised', 'invoice.voided', 'invoice.viewed', 'adjustment.requested', 'adjustment.approved', 'adjustment.rejected', 'adjustment.withdrawn', 'adjustment.listed', 'shift.opened', 'shift.closed', 'payment.recorded', 'payment.reversed', 'allocation.recorded', 'allocation.reversed', 'account.viewed', 'payment.viewed', 'refund.requested', 'refund.approved', 'refund.rejected', 'refund.withdrawn', 'refund.paid', 'refund.reversed', 'refund.listed', 'mpesa.settings_changed', 'mpesa.received', 'mpesa.assigned', 'mpesa.rejected', 'mpesa.listed', 'mpesa.stk_requested', 'mpesa.stk_viewed', 'adjustment.reversal_requested', 'adjustment.reversed', 'adjustment.reversal_rejected', 'adjustment.reversal_withdrawn', 'adjustment.reversals_listed', 'service_point.created', 'service_point.updated', 'queue.joined', 'queue.served', 'queue.finished', 'queue.removed', 'queue.viewed', 'charge.captured', 'billing.due_listed', 'observation.recorded', 'observation.entered_in_error', 'allergy.recorded', 'allergy.removed', 'diagnosis.recorded', 'diagnosis.confirmed', 'diagnosis.principal_set', 'diagnosis.ended', 'note.drafted', 'note.edited', 'note.signed', 'note.discarded', 'note.addendum_added', 'note.entered_in_error', 'lab_test.created', 'lab_test.updated', 'lab_analyte.added', 'lab_analyte.updated', 'lab_analyte.ranges_set', 'order.placed', 'order_item.cancelled', 'order_item.done', 'prescription.issued', 'prescription.cancelled', 'prescription.allergy_overridden'));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_kind_known" CHECK ("documents"."kind" IN ('receipt', 'invoice', 'credit_note', 'refund', 'prescription'));--> statement-breakpoint
ALTER TABLE "lab_analytes" ADD CONSTRAINT "lab_analytes_shape" CHECK (("lab_analytes"."result_type" = 'numeric' AND "lab_analytes"."choices" IS NULL AND "lab_analytes"."abnormal_choices" IS NULL
          AND ("lab_analytes"."unit" IS NULL OR length(btrim("lab_analytes"."unit")) > 0)
          AND ("lab_analytes"."critical_low" IS NULL OR "lab_analytes"."critical_high" IS NULL OR "lab_analytes"."critical_low" < "lab_analytes"."critical_high"))
      OR ("lab_analytes"."result_type" = 'choice' AND "lab_analytes"."unit" IS NULL AND "lab_analytes"."critical_low" IS NULL AND "lab_analytes"."critical_high" IS NULL
          AND "lab_analytes"."choices" IS NOT NULL AND cardinality("lab_analytes"."choices") >= 2
          AND "lab_analytes"."abnormal_choices" IS NOT NULL AND "lab_analytes"."abnormal_choices" <@ "lab_analytes"."choices")
      OR ("lab_analytes"."result_type" = 'text' AND "lab_analytes"."unit" IS NULL AND "lab_analytes"."choices" IS NULL AND "lab_analytes"."abnormal_choices" IS NULL
          AND "lab_analytes"."critical_low" IS NULL AND "lab_analytes"."critical_high" IS NULL));--> statement-breakpoint
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_kind_known" CHECK ("number_series"."kind" IN ('outpatient', 'inpatient', 'admission', 'receipt', 'invoice', 'credit_note', 'refund', 'prescription'));--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_route_known" CHECK ("order_items"."route" IN ('oral', 'sublingual', 'iv', 'im', 'sc', 'intradermal', 'topical', 'rectal', 'vaginal', 'inhaled', 'nasal', 'ophthalmic', 'otic'));--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_frequency_known" CHECK ("order_items"."frequency" IN ('od', 'bd', 'tds', 'qid', 'nocte', 'prn', 'stat'));--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_medication_shape" CHECK (("order_items"."drug_code" IS NULL AND num_nonnulls("order_items"."drug_description", "order_items"."dose_amount", "order_items"."dose_unit", "order_items"."route", "order_items"."frequency",
          "order_items"."duration_days", "order_items"."quantity", "order_items"."instructions", "order_items"."allergy_override_reason") = 0)
      OR ("order_items"."drug_code" IS NOT NULL AND "order_items"."drug_description" IS NOT NULL AND "order_items"."dose_unit" IS NOT NULL
          AND "order_items"."route" IS NOT NULL AND "order_items"."frequency" IS NOT NULL
          AND "order_items"."dose_amount" IS NOT NULL AND "order_items"."dose_amount" > 0 AND "order_items"."quantity" IS NOT NULL AND "order_items"."quantity" > 0
          AND CASE "order_items"."frequency"
                WHEN 'stat' THEN "order_items"."duration_days" IS NULL
                WHEN 'prn' THEN "order_items"."duration_days" IS NULL OR "order_items"."duration_days" > 0
                ELSE "order_items"."duration_days" IS NOT NULL AND "order_items"."duration_days" > 0
              END
          AND ("order_items"."instructions" IS NULL OR length(btrim("order_items"."instructions")) > 0)
          AND ("order_items"."allergy_override_reason" IS NULL OR length(btrim("order_items"."allergy_override_reason")) > 0)));--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_one_kind" CHECK (num_nonnulls("order_items"."lab_test_id", "order_items"."billable_item_id", "order_items"."drug_code") = 1);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_prescription_prescribed" CHECK ("orders"."document_id" IS NULL OR "orders"."ordered_by" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "patient_allergies" ADD CONSTRAINT "patient_allergies_drug_is_a_drug_allergy" CHECK ("patient_allergies"."drug_code" IS NULL OR "patient_allergies"."category" = 'drug');