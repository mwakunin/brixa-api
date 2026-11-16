CREATE TABLE "sensitive_drugs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"drug_code" text NOT NULL,
	"category" text,
	"marked_by" uuid NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sensitive_drugs_drug_key" UNIQUE("facility_id","drug_code"),
	CONSTRAINT "sensitive_drugs_category_known" CHECK ("sensitive_drugs"."category" IN ('hiv', 'mental_health', 'gbv'))
);
--> statement-breakpoint
ALTER TABLE "sensitive_drugs" ADD CONSTRAINT "sensitive_drugs_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensitive_drugs" ADD CONSTRAINT "sensitive_drugs_drug_fk" FOREIGN KEY ("drug_code") REFERENCES "public"."drug_catalogue"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensitive_drugs" ADD CONSTRAINT "sensitive_drugs_marked_by_fk" FOREIGN KEY ("facility_id","marked_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;