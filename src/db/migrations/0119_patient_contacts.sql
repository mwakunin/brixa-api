CREATE TABLE "patient_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"name" text NOT NULL,
	"relationship" text,
	"phone" text,
	"id_type" text,
	"id_value" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"added_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_contacts_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "patient_contacts_id_type_known" CHECK ("patient_contacts"."id_type" IN ('national_id', 'passport', 'birth_certificate', 'alien_id', 'refugee_id')),
	CONSTRAINT "patient_contacts_name_present" CHECK (length(btrim("patient_contacts"."name")) > 0),
	CONSTRAINT "patient_contacts_relationship_present" CHECK ("patient_contacts"."relationship" IS NULL OR length(btrim("patient_contacts"."relationship")) > 0),
	CONSTRAINT "patient_contacts_phone_e164" CHECK ("patient_contacts"."phone" IS NULL OR "patient_contacts"."phone" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "patient_contacts_id_complete" CHECK (("patient_contacts"."id_type" IS NULL) = ("patient_contacts"."id_value" IS NULL)),
	CONSTRAINT "patient_contacts_id_value_shape" CHECK ("patient_contacts"."id_value" IS NULL OR "patient_contacts"."id_value" ~ '^[A-Z0-9/-]{1,40}$')
);
--> statement-breakpoint
ALTER TABLE "patient_contacts" ADD CONSTRAINT "patient_contacts_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_contacts" ADD CONSTRAINT "patient_contacts_patient_fk" FOREIGN KEY ("facility_id","patient_id") REFERENCES "public"."patients"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_contacts" ADD CONSTRAINT "patient_contacts_added_by_fk" FOREIGN KEY ("facility_id","added_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patient_contacts_patient_index" ON "patient_contacts" USING btree ("facility_id","patient_id");