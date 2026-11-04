CREATE TABLE "allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"allocated_by" uuid NOT NULL,
	"allocated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversed_by" uuid,
	"reversal_reason" text,
	CONSTRAINT "allocations_amount_whole_shillings" CHECK ("allocations"."amount_cents" > 0 AND "allocations"."amount_cents" % 100 = 0),
	CONSTRAINT "allocations_reversal" CHECK (("allocations"."reversed_at" IS NULL AND "allocations"."reversed_by" IS NULL AND "allocations"."reversal_reason" IS NULL)
      OR ("allocations"."reversed_at" IS NOT NULL AND "allocations"."reversed_by" IS NOT NULL AND "allocations"."reversal_reason" IS NOT NULL AND length(btrim("allocations"."reversal_reason")) > 0))
);
--> statement-breakpoint
CREATE TABLE "cashier_shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"cashier_id" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opening_float_cents" integer DEFAULT 0 NOT NULL,
	"closed_at" timestamp with time zone,
	"declared_cash_cents" integer,
	CONSTRAINT "cashier_shifts_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "cashier_shifts_facility_id_id_cashier_id_key" UNIQUE("facility_id","id","cashier_id"),
	CONSTRAINT "cashier_shifts_float_whole_shillings" CHECK ("cashier_shifts"."opening_float_cents" >= 0 AND "cashier_shifts"."opening_float_cents" % 100 = 0),
	CONSTRAINT "cashier_shifts_closing" CHECK (("cashier_shifts"."closed_at" IS NULL AND "cashier_shifts"."declared_cash_cents" IS NULL)
      OR ("cashier_shifts"."closed_at" IS NOT NULL AND "cashier_shifts"."declared_cash_cents" >= 0 AND "cashier_shifts"."declared_cash_cents" % 100 = 0))
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"method" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"reference" text,
	"cashier_shift_id" uuid,
	"encounter_id" uuid,
	"document_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"received_by" uuid NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversed_by" uuid,
	"reversal_reason" text,
	CONSTRAINT "payments_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "payments_facility_id_id_account_id_key" UNIQUE("facility_id","id","account_id"),
	CONSTRAINT "payments_method_known" CHECK ("payments"."method" IN ('cash', 'card', 'bank')),
	CONSTRAINT "payments_amount_whole_shillings" CHECK ("payments"."amount_cents" > 0 AND "payments"."amount_cents" % 100 = 0),
	CONSTRAINT "payments_reference" CHECK (("payments"."method" = 'cash' AND "payments"."reference" IS NULL)
      OR ("payments"."method" <> 'cash' AND length(btrim("payments"."reference")) > 0)),
	CONSTRAINT "payments_counter_shift" CHECK (("payments"."method" IN ('cash', 'card')) = ("payments"."cashier_shift_id" IS NOT NULL)),
	CONSTRAINT "payments_reversal" CHECK (("payments"."reversed_at" IS NULL AND "payments"."reversed_by" IS NULL AND "payments"."reversal_reason" IS NULL)
      OR ("payments"."reversed_at" IS NOT NULL AND "payments"."reversed_by" IS NOT NULL AND "payments"."reversal_reason" IS NOT NULL AND length(btrim("payments"."reversal_reason")) > 0
          AND "payments"."reversed_by" <> "payments"."received_by"))
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_known";--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_payment_fk" FOREIGN KEY ("facility_id","payment_id","account_id") REFERENCES "public"."payments"("facility_id","id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_invoice_fk" FOREIGN KEY ("facility_id","invoice_id","account_id") REFERENCES "public"."invoices"("facility_id","id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_allocated_by_fk" FOREIGN KEY ("facility_id","allocated_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_reversed_by_fk" FOREIGN KEY ("facility_id","reversed_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cashier_shifts" ADD CONSTRAINT "cashier_shifts_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cashier_shifts" ADD CONSTRAINT "cashier_shifts_cashier_fk" FOREIGN KEY ("facility_id","cashier_id") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_account_fk" FOREIGN KEY ("facility_id","account_id") REFERENCES "public"."accounts"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_shift_fk" FOREIGN KEY ("facility_id","cashier_shift_id","received_by") REFERENCES "public"."cashier_shifts"("facility_id","id","cashier_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_encounter_fk" FOREIGN KEY ("facility_id","encounter_id") REFERENCES "public"."encounters"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_document_fk" FOREIGN KEY ("facility_id","document_id") REFERENCES "public"."documents"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_received_by_fk" FOREIGN KEY ("facility_id","received_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reversed_by_fk" FOREIGN KEY ("facility_id","reversed_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "allocations_payment_index" ON "allocations" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "allocations_invoice_index" ON "allocations" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cashier_shifts_one_open" ON "cashier_shifts" USING btree ("facility_id","cashier_id") WHERE "cashier_shifts"."closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "payments_account_index" ON "payments" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "payments_shift_index" ON "payments" USING btree ("cashier_shift_id");--> statement-breakpoint
CREATE INDEX "payments_encounter_index" ON "payments" USING btree ("encounter_id");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_known" CHECK ("audit_log"."action" IN ('facility.created', 'invitation.created', 'invitation.revoked', 'membership.granted', 'membership.roles_changed', 'membership.revoked', 'document.issued', 'document.voided', 'document.viewed', 'document.verified', 'patient.registered', 'patient.updated', 'patient.identifier_added', 'patient.viewed', 'patient.searched', 'encounter.opened', 'encounter.closed', 'encounter.cancelled', 'encounter.viewed', 'patient.admitted', 'patient.transferred', 'patient.discharged', 'ward.created', 'bed.created', 'billable_item.created', 'price_change.requested', 'price_change.approved', 'price_change.rejected', 'price_change.withdrawn', 'ward.bed_day_item_set', 'charge.posted', 'charge.accrued', 'charge.cancelled', 'invoice.drafted', 'invoice.finalised', 'invoice.voided', 'invoice.viewed', 'adjustment.requested', 'adjustment.approved', 'adjustment.rejected', 'adjustment.withdrawn', 'adjustment.listed', 'shift.opened', 'shift.closed', 'payment.recorded', 'payment.reversed', 'allocation.recorded', 'allocation.reversed', 'account.viewed', 'payment.viewed'));