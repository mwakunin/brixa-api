CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"patient_id" uuid,
	"payer_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "accounts_facility_id_patient_id_key" UNIQUE("facility_id","patient_id"),
	CONSTRAINT "accounts_facility_id_payer_id_key" UNIQUE("facility_id","payer_id"),
	CONSTRAINT "accounts_kind_known" CHECK ("accounts"."kind" IN ('patient', 'payer')),
	CONSTRAINT "accounts_one_owner" CHECK (num_nonnulls("accounts"."patient_id", "accounts"."payer_id") = 1),
	CONSTRAINT "accounts_kind_matches" CHECK (("accounts"."kind" = 'patient') = ("accounts"."patient_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "charge_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"charge_id" uuid NOT NULL,
	"invoice_line_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"mode" text NOT NULL,
	CONSTRAINT "charge_assignments_mode_known" CHECK ("charge_assignments"."mode" IN ('itemised', 'absorbed')),
	CONSTRAINT "charge_assignments_amount_whole_shillings" CHECK ("charge_assignments"."amount_cents" > 0 AND "charge_assignments"."amount_cents" % 100 = 0)
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(11, 3) NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"service_date" date NOT NULL,
	CONSTRAINT "invoice_lines_facility_id_id_account_id_key" UNIQUE("facility_id","id","account_id"),
	CONSTRAINT "invoice_lines_kind_known" CHECK ("invoice_lines"."kind" IN ('itemised')),
	CONSTRAINT "invoice_lines_amount_whole_shillings" CHECK ("invoice_lines"."amount_cents" > 0 AND "invoice_lines"."amount_cents" % 100 = 0)
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"total_cents" integer,
	"document_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalised_at" timestamp with time zone,
	"finalised_by" uuid,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "invoices_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "invoices_facility_id_id_account_id_key" UNIQUE("facility_id","id","account_id"),
	CONSTRAINT "invoices_kind_known" CHECK ("invoices"."kind" IN ('interim', 'final', 'supplementary')),
	CONSTRAINT "invoices_status_known" CHECK ("invoices"."status" IN ('draft', 'finalised', 'void')),
	CONSTRAINT "invoices_lifecycle" CHECK (("invoices"."status" = 'draft' AND "invoices"."total_cents" IS NULL AND "invoices"."document_id" IS NULL AND "invoices"."finalised_at" IS NULL
          AND "invoices"."finalised_by" IS NULL AND "invoices"."voided_at" IS NULL AND "invoices"."voided_by" IS NULL AND "invoices"."void_reason" IS NULL)
      OR ("invoices"."status" = 'finalised' AND "invoices"."total_cents" IS NOT NULL AND "invoices"."document_id" IS NOT NULL
          AND "invoices"."finalised_at" IS NOT NULL AND "invoices"."finalised_by" IS NOT NULL
          AND "invoices"."voided_at" IS NULL AND "invoices"."voided_by" IS NULL AND "invoices"."void_reason" IS NULL)
      OR ("invoices"."status" = 'void' AND "invoices"."voided_at" IS NOT NULL AND "invoices"."voided_by" IS NOT NULL
          AND length(btrim("invoices"."void_reason")) > 0)),
	CONSTRAINT "invoices_total_whole_shillings" CHECK ("invoices"."total_cents" IS NULL OR ("invoices"."total_cents" >= 0 AND "invoices"."total_cents" % 100 = 0))
);
--> statement-breakpoint
CREATE TABLE "payers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payers_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "payers_facility_id_name_key" UNIQUE("facility_id","name"),
	CONSTRAINT "payers_name_present" CHECK (length(btrim("payers"."name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_known";--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_kind_known";--> statement-breakpoint
ALTER TABLE "number_series" DROP CONSTRAINT "number_series_kind_known";--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_patient_fk" FOREIGN KEY ("facility_id","patient_id") REFERENCES "public"."patients"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_payer_fk" FOREIGN KEY ("facility_id","payer_id") REFERENCES "public"."payers"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_assignments" ADD CONSTRAINT "charge_assignments_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_assignments" ADD CONSTRAINT "charge_assignments_charge_fk" FOREIGN KEY ("facility_id","charge_id") REFERENCES "public"."charges"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_assignments" ADD CONSTRAINT "charge_assignments_line_fk" FOREIGN KEY ("facility_id","invoice_line_id","account_id") REFERENCES "public"."invoice_lines"("facility_id","id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_fk" FOREIGN KEY ("facility_id","invoice_id","account_id") REFERENCES "public"."invoices"("facility_id","id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_account_fk" FOREIGN KEY ("facility_id","account_id") REFERENCES "public"."accounts"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_encounter_fk" FOREIGN KEY ("facility_id","encounter_id") REFERENCES "public"."encounters"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_document_fk" FOREIGN KEY ("facility_id","document_id") REFERENCES "public"."documents"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_fk" FOREIGN KEY ("facility_id","created_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_finalised_by_fk" FOREIGN KEY ("facility_id","finalised_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_voided_by_fk" FOREIGN KEY ("facility_id","voided_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payers" ADD CONSTRAINT "payers_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "charge_assignments_charge_index" ON "charge_assignments" USING btree ("charge_id");--> statement-breakpoint
CREATE INDEX "charge_assignments_line_index" ON "charge_assignments" USING btree ("invoice_line_id");--> statement-breakpoint
CREATE INDEX "invoice_lines_invoice_index" ON "invoice_lines" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_one_live_final" ON "invoices" USING btree ("encounter_id","account_id") WHERE "invoices"."kind" = 'final' AND "invoices"."status" <> 'void';--> statement-breakpoint
CREATE INDEX "invoices_encounter_index" ON "invoices" USING btree ("facility_id","encounter_id");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_known" CHECK ("audit_log"."action" IN ('facility.created', 'invitation.created', 'invitation.revoked', 'membership.granted', 'membership.roles_changed', 'membership.revoked', 'document.issued', 'document.voided', 'document.viewed', 'document.verified', 'patient.registered', 'patient.updated', 'patient.identifier_added', 'patient.viewed', 'patient.searched', 'encounter.opened', 'encounter.closed', 'encounter.cancelled', 'encounter.viewed', 'patient.admitted', 'patient.transferred', 'patient.discharged', 'ward.created', 'bed.created', 'billable_item.created', 'price_change.requested', 'price_change.approved', 'price_change.rejected', 'price_change.withdrawn', 'ward.bed_day_item_set', 'charge.posted', 'charge.accrued', 'charge.cancelled', 'invoice.drafted', 'invoice.finalised', 'invoice.voided', 'invoice.viewed'));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_kind_known" CHECK ("documents"."kind" IN ('receipt', 'invoice', 'credit_note'));--> statement-breakpoint
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_kind_known" CHECK ("number_series"."kind" IN ('outpatient', 'inpatient', 'admission', 'receipt', 'invoice', 'credit_note'));