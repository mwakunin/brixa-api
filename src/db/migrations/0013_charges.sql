CREATE TABLE "charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"billable_item_id" uuid NOT NULL,
	"quantity" numeric(11, 3) NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"price_list_item_id" uuid NOT NULL,
	"service_date" date NOT NULL,
	"bed_stay_id" uuid,
	"manual_reason" text,
	"captured_by" uuid,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancellation_reason" text,
	CONSTRAINT "charges_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "charges_quantity_positive" CHECK ("charges"."quantity" > 0),
	CONSTRAINT "charges_unit_price_nonnegative" CHECK ("charges"."unit_price_cents" >= 0),
	CONSTRAINT "charges_amount_whole_shillings" CHECK ("charges"."amount_cents" >= 0 AND "charges"."amount_cents" % 100 = 0),
	CONSTRAINT "charges_source_or_reason" CHECK (num_nonnulls("charges"."bed_stay_id") <= 1
      AND ((num_nonnulls("charges"."bed_stay_id") = 0) = ("charges"."manual_reason" IS NOT NULL AND length(btrim("charges"."manual_reason")) > 0))),
	CONSTRAINT "charges_manual_has_person" CHECK ("charges"."manual_reason" IS NULL OR "charges"."captured_by" IS NOT NULL),
	CONSTRAINT "charges_cancellation_complete" CHECK (("charges"."cancelled_at" IS NULL AND "charges"."cancelled_by" IS NULL AND "charges"."cancellation_reason" IS NULL)
      OR ("charges"."cancelled_at" IS NOT NULL AND "charges"."cancelled_by" IS NOT NULL AND length(btrim("charges"."cancellation_reason")) > 0))
);
--> statement-breakpoint
CREATE TABLE "job_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"job" text NOT NULL,
	"subject_id" uuid,
	"error" text NOT NULL,
	"failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "job_failures_job_known" CHECK ("job_failures"."job" IN ('bed_day_accrual'))
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_known";--> statement-breakpoint
ALTER TABLE "wards" ADD COLUMN "bed_day_item_id" uuid;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_encounter_fk" FOREIGN KEY ("facility_id","encounter_id") REFERENCES "public"."encounters"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_item_fk" FOREIGN KEY ("facility_id","billable_item_id") REFERENCES "public"."billable_items"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_price_fk" FOREIGN KEY ("facility_id","price_list_item_id") REFERENCES "public"."price_list_items"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_bed_stay_fk" FOREIGN KEY ("facility_id","bed_stay_id") REFERENCES "public"."bed_stays"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_captured_by_fk" FOREIGN KEY ("facility_id","captured_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_cancelled_by_fk" FOREIGN KEY ("facility_id","cancelled_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_failures" ADD CONSTRAINT "job_failures_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "charges_encounter_index" ON "charges" USING btree ("facility_id","encounter_id","service_date");--> statement-breakpoint
CREATE UNIQUE INDEX "charges_one_bed_day_per_night" ON "charges" USING btree ("encounter_id","service_date") WHERE "charges"."bed_stay_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "job_failures_open_once" ON "job_failures" USING btree ("facility_id","job","subject_id","error") WHERE "job_failures"."resolved_at" IS NULL;--> statement-breakpoint
ALTER TABLE "wards" ADD CONSTRAINT "wards_bed_day_item_fk" FOREIGN KEY ("facility_id","bed_day_item_id") REFERENCES "public"."billable_items"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_known" CHECK ("audit_log"."action" IN ('facility.created', 'invitation.created', 'invitation.revoked', 'membership.granted', 'membership.roles_changed', 'membership.revoked', 'document.issued', 'document.voided', 'document.viewed', 'document.verified', 'patient.registered', 'patient.updated', 'patient.identifier_added', 'patient.viewed', 'patient.searched', 'encounter.opened', 'encounter.closed', 'encounter.cancelled', 'encounter.viewed', 'patient.admitted', 'patient.transferred', 'patient.discharged', 'ward.created', 'bed.created', 'billable_item.created', 'price_change.requested', 'price_change.approved', 'price_change.rejected', 'price_change.withdrawn', 'ward.bed_day_item_set', 'charge.posted', 'charge.accrued', 'charge.cancelled'));