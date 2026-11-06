CREATE TABLE "patient_identifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"type" text NOT NULL,
	"value" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"added_by" uuid NOT NULL,
	CONSTRAINT "patient_identifiers_patient_id_type_value_key" UNIQUE("patient_id","type","value"),
	CONSTRAINT "patient_identifiers_type_known" CHECK ("patient_identifiers"."type" IN ('national_id', 'passport', 'birth_certificate', 'alien_id', 'refugee_id', 'sha_number', 'client_registry_id', 'other')),
	CONSTRAINT "patient_identifiers_value_shape" CHECK ("patient_identifiers"."value" ~ '^[A-Z0-9/-]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "patient_numbers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"number" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_numbers_facility_id_number_key" UNIQUE("facility_id","number"),
	CONSTRAINT "patient_numbers_patient_id_kind_key" UNIQUE("patient_id","kind"),
	CONSTRAINT "patient_numbers_kind_known" CHECK ("patient_numbers"."kind" IN ('outpatient', 'inpatient'))
);
--> statement-breakpoint
CREATE TABLE "patients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"given_name" text NOT NULL,
	"middle_names" text,
	"family_name" text NOT NULL,
	"date_of_birth" date NOT NULL,
	"dob_is_estimated" boolean DEFAULT false NOT NULL,
	"sex" text,
	"phone" text,
	"no_phone_reason" text,
	"no_id_reason" text,
	"unidentified" boolean DEFAULT false NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"registered_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patients_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "patients_sex_known" CHECK ("patients"."sex" IN ('male', 'female', 'intersex')),
	CONSTRAINT "patients_no_phone_reason_known" CHECK ("patients"."no_phone_reason" IN ('no_phone', 'unidentified')),
	CONSTRAINT "patients_no_id_reason_known" CHECK ("patients"."no_id_reason" IN ('none_held', 'not_carried', 'unidentified')),
	CONSTRAINT "patients_names_present" CHECK (length(btrim("patients"."given_name")) > 0 AND length(btrim("patients"."family_name")) > 0),
	CONSTRAINT "patients_phone_e164" CHECK ("patients"."phone" IS NULL OR "patients"."phone" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "patients_phone_or_reason" CHECK (("patients"."phone" IS NULL) = ("patients"."no_phone_reason" IS NOT NULL)),
	CONSTRAINT "patients_sex_unless_unidentified" CHECK ("patients"."sex" IS NOT NULL OR "patients"."unidentified"),
	CONSTRAINT "patients_unidentified_reasons" CHECK (("patients"."no_phone_reason" IS DISTINCT FROM 'unidentified' AND "patients"."no_id_reason" IS DISTINCT FROM 'unidentified') OR "patients"."unidentified")
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_known";--> statement-breakpoint
ALTER TABLE "patient_identifiers" ADD CONSTRAINT "patient_identifiers_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_identifiers" ADD CONSTRAINT "patient_identifiers_patient_fk" FOREIGN KEY ("facility_id","patient_id") REFERENCES "public"."patients"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_identifiers" ADD CONSTRAINT "patient_identifiers_added_by_fk" FOREIGN KEY ("facility_id","added_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_numbers" ADD CONSTRAINT "patient_numbers_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_numbers" ADD CONSTRAINT "patient_numbers_patient_fk" FOREIGN KEY ("facility_id","patient_id") REFERENCES "public"."patients"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_registered_by_fk" FOREIGN KEY ("facility_id","registered_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patient_identifiers_lookup_index" ON "patient_identifiers" USING btree ("facility_id","value");--> statement-breakpoint
CREATE INDEX "patient_numbers_number_search_index" ON "patient_numbers" USING btree ("facility_id",upper("number"));--> statement-breakpoint
CREATE INDEX "patients_family_name_index" ON "patients" USING btree ("facility_id",lower("family_name"));--> statement-breakpoint
CREATE INDEX "patients_phone_index" ON "patients" USING btree ("facility_id","phone");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_known" CHECK ("audit_log"."action" IN ('facility.created', 'invitation.created', 'invitation.revoked', 'membership.granted', 'membership.roles_changed', 'membership.revoked', 'document.issued', 'document.voided', 'document.viewed', 'document.verified', 'patient.registered', 'patient.updated', 'patient.identifier_added', 'patient.viewed', 'patient.searched'));