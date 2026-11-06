CREATE TABLE "admissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"admission_number" text NOT NULL,
	"admitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"admitted_by" uuid NOT NULL,
	"discharged_at" timestamp with time zone,
	"discharged_by" uuid,
	"discharge_disposition" text,
	CONSTRAINT "admissions_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "admissions_encounter_id_key" UNIQUE("encounter_id"),
	CONSTRAINT "admissions_facility_id_admission_number_key" UNIQUE("facility_id","admission_number"),
	CONSTRAINT "admissions_discharge_disposition_known" CHECK ("admissions"."discharge_disposition" IN ('home', 'referred', 'died', 'absconded', 'against_advice')),
	CONSTRAINT "admissions_discharge_complete" CHECK (("admissions"."discharged_at" IS NULL AND "admissions"."discharged_by" IS NULL AND "admissions"."discharge_disposition" IS NULL)
      OR ("admissions"."discharged_at" IS NOT NULL AND "admissions"."discharged_by" IS NOT NULL AND "admissions"."discharge_disposition" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "bed_stays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"bed_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"started_by" uuid NOT NULL,
	"ended_by" uuid,
	CONSTRAINT "bed_stays_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "bed_stays_ends_after_start" CHECK ("bed_stays"."ended_at" IS NULL OR "bed_stays"."ended_at" >= "bed_stays"."started_at"),
	CONSTRAINT "bed_stays_ended_by_whom" CHECK (("bed_stays"."ended_at" IS NULL) = ("bed_stays"."ended_by" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "beds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"ward_id" uuid NOT NULL,
	"label" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "beds_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "beds_ward_id_label_key" UNIQUE("ward_id","label"),
	CONSTRAINT "beds_label_present" CHECK (length(btrim("beds"."label")) > 0)
);
--> statement-breakpoint
CREATE TABLE "encounters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"opened_by" uuid NOT NULL,
	"closed_by" uuid,
	"cancel_reason" text,
	"parent_encounter_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "encounters_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "encounters_kind_known" CHECK ("encounters"."kind" IN ('opd', 'emergency', 'ipd')),
	CONSTRAINT "encounters_status_known" CHECK ("encounters"."status" IN ('open', 'closed', 'cancelled')),
	CONSTRAINT "encounters_lifecycle" CHECK (("encounters"."status" = 'open' AND "encounters"."ended_at" IS NULL AND "encounters"."closed_by" IS NULL AND "encounters"."cancel_reason" IS NULL)
      OR ("encounters"."status" = 'closed' AND "encounters"."ended_at" IS NOT NULL AND "encounters"."closed_by" IS NOT NULL AND "encounters"."cancel_reason" IS NULL)
      OR ("encounters"."status" = 'cancelled' AND "encounters"."ended_at" IS NOT NULL AND "encounters"."closed_by" IS NOT NULL
          AND "encounters"."cancel_reason" IS NOT NULL AND length(btrim("encounters"."cancel_reason")) > 0)),
	CONSTRAINT "encounters_ends_after_start" CHECK ("encounters"."ended_at" IS NULL OR "encounters"."ended_at" >= "encounters"."started_at")
);
--> statement-breakpoint
CREATE TABLE "wards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wards_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "wards_facility_id_name_key" UNIQUE("facility_id","name"),
	CONSTRAINT "wards_name_present" CHECK (length(btrim("wards"."name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_known";--> statement-breakpoint
ALTER TABLE "number_series" DROP CONSTRAINT "number_series_kind_known";--> statement-breakpoint
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_encounter_fk" FOREIGN KEY ("facility_id","encounter_id") REFERENCES "public"."encounters"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_admitted_by_fk" FOREIGN KEY ("facility_id","admitted_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_discharged_by_fk" FOREIGN KEY ("facility_id","discharged_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bed_stays" ADD CONSTRAINT "bed_stays_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bed_stays" ADD CONSTRAINT "bed_stays_admission_fk" FOREIGN KEY ("facility_id","admission_id") REFERENCES "public"."admissions"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bed_stays" ADD CONSTRAINT "bed_stays_bed_fk" FOREIGN KEY ("facility_id","bed_id") REFERENCES "public"."beds"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bed_stays" ADD CONSTRAINT "bed_stays_started_by_fk" FOREIGN KEY ("facility_id","started_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bed_stays" ADD CONSTRAINT "bed_stays_ended_by_fk" FOREIGN KEY ("facility_id","ended_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beds" ADD CONSTRAINT "beds_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beds" ADD CONSTRAINT "beds_ward_fk" FOREIGN KEY ("facility_id","ward_id") REFERENCES "public"."wards"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_patient_fk" FOREIGN KEY ("facility_id","patient_id") REFERENCES "public"."patients"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_opened_by_fk" FOREIGN KEY ("facility_id","opened_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_closed_by_fk" FOREIGN KEY ("facility_id","closed_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_parent_fk" FOREIGN KEY ("facility_id","parent_encounter_id") REFERENCES "public"."encounters"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wards" ADD CONSTRAINT "wards_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bed_stays_admission_index" ON "bed_stays" USING btree ("facility_id","admission_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "encounters_one_open_per_patient_and_kind" ON "encounters" USING btree ("facility_id","patient_id","kind") WHERE "encounters"."status" = 'open';--> statement-breakpoint
CREATE INDEX "encounters_patient_index" ON "encounters" USING btree ("facility_id","patient_id","started_at");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_known" CHECK ("audit_log"."action" IN ('facility.created', 'invitation.created', 'invitation.revoked', 'membership.granted', 'membership.roles_changed', 'membership.revoked', 'document.issued', 'document.voided', 'document.viewed', 'document.verified', 'patient.registered', 'patient.updated', 'patient.identifier_added', 'patient.viewed', 'patient.searched', 'encounter.opened', 'encounter.closed', 'encounter.cancelled', 'encounter.viewed', 'patient.admitted', 'patient.transferred', 'patient.discharged', 'ward.created', 'bed.created'));--> statement-breakpoint
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_kind_known" CHECK ("number_series"."kind" IN ('outpatient', 'inpatient', 'admission', 'receipt'));