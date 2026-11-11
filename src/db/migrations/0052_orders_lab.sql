CREATE TABLE "lab_analytes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"lab_test_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"result_type" text NOT NULL,
	"unit" text,
	"choices" text[],
	"abnormal_choices" text[],
	"critical_low" numeric,
	"critical_high" numeric,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lab_analytes_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "lab_analytes_test_code_key" UNIQUE("lab_test_id","code"),
	CONSTRAINT "lab_analytes_result_type_known" CHECK ("lab_analytes"."result_type" IN ('numeric', 'choice', 'text')),
	CONSTRAINT "lab_analytes_code_shape" CHECK ("lab_analytes"."code" ~ '^[A-Z0-9][A-Z0-9._%#-]{0,15}$'),
	CONSTRAINT "lab_analytes_name_present" CHECK (length(btrim("lab_analytes"."name")) > 0),
	CONSTRAINT "lab_analytes_position_nonnegative" CHECK ("lab_analytes"."position" >= 0),
	CONSTRAINT "lab_analytes_shape" CHECK (("lab_analytes"."result_type" = 'numeric' AND "lab_analytes"."choices" IS NULL AND "lab_analytes"."abnormal_choices" IS NULL
          AND ("lab_analytes"."unit" IS NULL OR length(btrim("lab_analytes"."unit")) > 0)
          AND ("lab_analytes"."critical_low" IS NULL OR "lab_analytes"."critical_high" IS NULL OR "lab_analytes"."critical_low" < "lab_analytes"."critical_high"))
      OR ("lab_analytes"."result_type" = 'choice' AND "lab_analytes"."unit" IS NULL AND "lab_analytes"."critical_low" IS NULL AND "lab_analytes"."critical_high" IS NULL
          AND cardinality("lab_analytes"."choices") >= 2 AND "lab_analytes"."abnormal_choices" IS NOT NULL AND "lab_analytes"."abnormal_choices" <@ "lab_analytes"."choices")
      OR ("lab_analytes"."result_type" = 'text' AND "lab_analytes"."unit" IS NULL AND "lab_analytes"."choices" IS NULL AND "lab_analytes"."abnormal_choices" IS NULL
          AND "lab_analytes"."critical_low" IS NULL AND "lab_analytes"."critical_high" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "lab_reference_ranges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"analyte_id" uuid NOT NULL,
	"sex" text NOT NULL,
	"age_from_days" integer NOT NULL,
	"age_to_days" integer,
	"low" numeric,
	"high" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "lab_reference_ranges_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "lab_reference_ranges_sex_known" CHECK ("lab_reference_ranges"."sex" IN ('any', 'male', 'female')),
	CONSTRAINT "lab_reference_ranges_ages" CHECK ("lab_reference_ranges"."age_from_days" >= 0 AND ("lab_reference_ranges"."age_to_days" IS NULL OR "lab_reference_ranges"."age_to_days" > "lab_reference_ranges"."age_from_days")),
	CONSTRAINT "lab_reference_ranges_bounds" CHECK (num_nonnulls("lab_reference_ranges"."low", "lab_reference_ranges"."high") >= 1 AND ("lab_reference_ranges"."low" IS NULL OR "lab_reference_ranges"."high" IS NULL OR "lab_reference_ranges"."low" < "lab_reference_ranges"."high"))
);
--> statement-breakpoint
CREATE TABLE "lab_tests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"billable_item_id" uuid NOT NULL,
	"specimen_type" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lab_tests_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "lab_tests_billable_item_key" UNIQUE("facility_id","billable_item_id"),
	CONSTRAINT "lab_tests_specimen_type_known" CHECK ("lab_tests"."specimen_type" IN ('blood', 'urine', 'stool', 'sputum', 'swab', 'csf', 'body_fluid', 'other'))
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"lab_test_id" uuid,
	"billable_item_id" uuid,
	"status" text NOT NULL,
	"done_at" timestamp with time zone,
	"done_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancellation_reason" text,
	CONSTRAINT "order_items_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "order_items_status_known" CHECK ("order_items"."status" IN ('ordered', 'done', 'cancelled')),
	CONSTRAINT "order_items_one_kind" CHECK (num_nonnulls("order_items"."lab_test_id", "order_items"."billable_item_id") = 1),
	CONSTRAINT "order_items_lifecycle" CHECK (("order_items"."status" = 'ordered' AND num_nonnulls("order_items"."done_at", "order_items"."done_by", "order_items"."cancelled_at", "order_items"."cancelled_by", "order_items"."cancellation_reason") = 0)
      OR ("order_items"."status" = 'done' AND "order_items"."done_at" IS NOT NULL AND "order_items"."done_by" IS NOT NULL
          AND num_nonnulls("order_items"."cancelled_at", "order_items"."cancelled_by", "order_items"."cancellation_reason") = 0)
      OR ("order_items"."status" = 'cancelled' AND "order_items"."cancelled_at" IS NOT NULL AND "order_items"."cancelled_by" IS NOT NULL
          AND "order_items"."cancellation_reason" IS NOT NULL AND length(btrim("order_items"."cancellation_reason")) > 0
          AND num_nonnulls("order_items"."done_at", "order_items"."done_by") = 0))
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"urgency" text NOT NULL,
	"indication" text,
	"ordered_by" uuid,
	"requester_name" text,
	"requester_facility" text,
	"requester_licence" text,
	"self_requested" boolean DEFAULT false NOT NULL,
	"entered_by" uuid NOT NULL,
	"ordered_at" timestamp with time zone NOT NULL,
	CONSTRAINT "orders_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "orders_urgency_known" CHECK ("orders"."urgency" IN ('routine', 'urgent')),
	CONSTRAINT "orders_one_requester" CHECK (num_nonnulls("orders"."ordered_by", "orders"."requester_name") + "orders"."self_requested"::int = 1
      AND ("orders"."requester_name" IS NULL) = ("orders"."requester_facility" IS NULL)
      AND ("orders"."requester_licence" IS NULL OR "orders"."requester_name" IS NOT NULL)
      AND ("orders"."ordered_by" IS NULL OR "orders"."ordered_by" = "orders"."entered_by")),
	CONSTRAINT "orders_text_present" CHECK (("orders"."indication" IS NULL OR length(btrim("orders"."indication")) > 0)
      AND ("orders"."requester_name" IS NULL OR length(btrim("orders"."requester_name")) > 0)
      AND ("orders"."requester_facility" IS NULL OR length(btrim("orders"."requester_facility")) > 0)
      AND ("orders"."requester_licence" IS NULL OR length(btrim("orders"."requester_licence")) > 0))
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_known";--> statement-breakpoint
ALTER TABLE "charges" DROP CONSTRAINT "charges_source_or_reason";--> statement-breakpoint
ALTER TABLE "charges" ADD COLUMN "order_item_id" uuid;--> statement-breakpoint
ALTER TABLE "lab_analytes" ADD CONSTRAINT "lab_analytes_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_analytes" ADD CONSTRAINT "lab_analytes_test_fk" FOREIGN KEY ("facility_id","lab_test_id") REFERENCES "public"."lab_tests"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_reference_ranges" ADD CONSTRAINT "lab_reference_ranges_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_reference_ranges" ADD CONSTRAINT "lab_reference_ranges_analyte_fk" FOREIGN KEY ("facility_id","analyte_id") REFERENCES "public"."lab_analytes"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_tests" ADD CONSTRAINT "lab_tests_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_tests" ADD CONSTRAINT "lab_tests_billable_item_fk" FOREIGN KEY ("facility_id","billable_item_id") REFERENCES "public"."billable_items"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_fk" FOREIGN KEY ("facility_id","order_id") REFERENCES "public"."orders"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_lab_test_fk" FOREIGN KEY ("facility_id","lab_test_id") REFERENCES "public"."lab_tests"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_billable_item_fk" FOREIGN KEY ("facility_id","billable_item_id") REFERENCES "public"."billable_items"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_done_by_fk" FOREIGN KEY ("facility_id","done_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_cancelled_by_fk" FOREIGN KEY ("facility_id","cancelled_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_encounter_fk" FOREIGN KEY ("facility_id","encounter_id") REFERENCES "public"."encounters"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_ordered_by_fk" FOREIGN KEY ("facility_id","ordered_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_entered_by_fk" FOREIGN KEY ("facility_id","entered_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lab_reference_ranges_current_index" ON "lab_reference_ranges" USING btree ("facility_id","analyte_id") WHERE "lab_reference_ranges"."retired_at" IS NULL;--> statement-breakpoint
CREATE INDEX "order_items_order_index" ON "order_items" USING btree ("facility_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_items_lab_test_once" ON "order_items" USING btree ("order_id","lab_test_id") WHERE "order_items"."lab_test_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "order_items_service_once" ON "order_items" USING btree ("order_id","billable_item_id") WHERE "order_items"."billable_item_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "orders_encounter_index" ON "orders" USING btree ("facility_id","encounter_id","ordered_at");--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_order_item_fk" FOREIGN KEY ("facility_id","order_item_id") REFERENCES "public"."order_items"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "charges_one_per_order_item" ON "charges" USING btree ("order_item_id") WHERE "charges"."order_item_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_known" CHECK ("audit_log"."action" IN ('facility.created', 'invitation.created', 'invitation.revoked', 'membership.granted', 'membership.roles_changed', 'membership.revoked', 'membership.licence_changed', 'document.issued', 'document.voided', 'document.viewed', 'document.verified', 'patient.registered', 'patient.updated', 'patient.identifier_added', 'patient.viewed', 'patient.searched', 'encounter.opened', 'encounter.closed', 'encounter.cancelled', 'encounter.viewed', 'patient.admitted', 'patient.transferred', 'patient.discharged', 'ward.created', 'bed.created', 'billable_item.created', 'price_change.requested', 'price_change.approved', 'price_change.rejected', 'price_change.withdrawn', 'ward.bed_day_item_set', 'charge.posted', 'charge.accrued', 'charge.cancelled', 'invoice.drafted', 'invoice.finalised', 'invoice.voided', 'invoice.viewed', 'adjustment.requested', 'adjustment.approved', 'adjustment.rejected', 'adjustment.withdrawn', 'adjustment.listed', 'shift.opened', 'shift.closed', 'payment.recorded', 'payment.reversed', 'allocation.recorded', 'allocation.reversed', 'account.viewed', 'payment.viewed', 'refund.requested', 'refund.approved', 'refund.rejected', 'refund.withdrawn', 'refund.paid', 'refund.reversed', 'refund.listed', 'mpesa.settings_changed', 'mpesa.received', 'mpesa.assigned', 'mpesa.rejected', 'mpesa.listed', 'mpesa.stk_requested', 'mpesa.stk_viewed', 'adjustment.reversal_requested', 'adjustment.reversed', 'adjustment.reversal_rejected', 'adjustment.reversal_withdrawn', 'adjustment.reversals_listed', 'service_point.created', 'service_point.updated', 'queue.joined', 'queue.served', 'queue.finished', 'queue.removed', 'queue.viewed', 'charge.captured', 'billing.due_listed', 'observation.recorded', 'observation.entered_in_error', 'allergy.recorded', 'allergy.removed', 'diagnosis.recorded', 'diagnosis.confirmed', 'diagnosis.principal_set', 'diagnosis.ended', 'note.drafted', 'note.edited', 'note.signed', 'note.discarded', 'note.addendum_added', 'note.entered_in_error', 'lab_test.created', 'lab_test.updated', 'lab_analyte.added', 'lab_analyte.updated', 'lab_analyte.ranges_set', 'order.placed', 'order_item.cancelled', 'order_item.done'));--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_source_or_reason" CHECK (num_nonnulls("charges"."bed_stay_id", "charges"."queue_entry_id", "charges"."order_item_id") <= 1
      AND ((num_nonnulls("charges"."bed_stay_id", "charges"."queue_entry_id", "charges"."order_item_id") = 0) = ("charges"."manual_reason" IS NOT NULL AND length(btrim("charges"."manual_reason")) > 0)));