CREATE TABLE "billable_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billable_items_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "billable_items_facility_id_code_key" UNIQUE("facility_id","code"),
	CONSTRAINT "billable_items_category_known" CHECK ("billable_items"."category" IN ('consultation', 'bed_day', 'lab', 'imaging', 'procedure', 'drug', 'consumable', 'service', 'other')),
	CONSTRAINT "billable_items_code_shape" CHECK ("billable_items"."code" ~ '^[A-Z0-9][A-Z0-9./-]{0,23}$'),
	CONSTRAINT "billable_items_name_present" CHECK (length(btrim("billable_items"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "price_change_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"price_change_id" uuid NOT NULL,
	"billable_item_id" uuid NOT NULL,
	"unit_price_cents" integer NOT NULL,
	CONSTRAINT "price_change_lines_change_item_key" UNIQUE("price_change_id","billable_item_id"),
	CONSTRAINT "price_change_lines_price_nonnegative" CHECK ("price_change_lines"."unit_price_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "price_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"price_list_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"effective_from" date NOT NULL,
	"reason" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	CONSTRAINT "price_changes_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "price_changes_status_known" CHECK ("price_changes"."status" IN ('pending', 'approved', 'rejected', 'withdrawn')),
	CONSTRAINT "price_changes_reason_present" CHECK (length(btrim("price_changes"."reason")) > 0),
	CONSTRAINT "price_changes_decision" CHECK (("price_changes"."status" = 'pending' AND "price_changes"."decided_by" IS NULL AND "price_changes"."decided_at" IS NULL)
      OR ("price_changes"."status" IN ('approved', 'rejected') AND "price_changes"."decided_by" IS NOT NULL AND "price_changes"."decided_at" IS NOT NULL
          AND "price_changes"."decided_by" <> "price_changes"."requested_by")
      OR ("price_changes"."status" = 'withdrawn' AND "price_changes"."decided_by" = "price_changes"."requested_by" AND "price_changes"."decided_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "price_list_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"price_list_id" uuid NOT NULL,
	"billable_item_id" uuid NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"price_change_id" uuid NOT NULL,
	CONSTRAINT "price_list_items_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "price_list_items_price_nonnegative" CHECK ("price_list_items"."unit_price_cents" >= 0),
	CONSTRAINT "price_list_items_valid_range" CHECK ("price_list_items"."valid_to" IS NULL OR "price_list_items"."valid_to" >= "price_list_items"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "price_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_lists_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "price_lists_kind_known" CHECK ("price_lists"."kind" IN ('cash'))
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_known";--> statement-breakpoint
ALTER TABLE "billable_items" ADD CONSTRAINT "billable_items_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_change_lines" ADD CONSTRAINT "price_change_lines_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_change_lines" ADD CONSTRAINT "price_change_lines_change_fk" FOREIGN KEY ("facility_id","price_change_id") REFERENCES "public"."price_changes"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_change_lines" ADD CONSTRAINT "price_change_lines_item_fk" FOREIGN KEY ("facility_id","billable_item_id") REFERENCES "public"."billable_items"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_changes" ADD CONSTRAINT "price_changes_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_changes" ADD CONSTRAINT "price_changes_price_list_fk" FOREIGN KEY ("facility_id","price_list_id") REFERENCES "public"."price_lists"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_changes" ADD CONSTRAINT "price_changes_requested_by_fk" FOREIGN KEY ("facility_id","requested_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_changes" ADD CONSTRAINT "price_changes_decided_by_fk" FOREIGN KEY ("facility_id","decided_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_list_fk" FOREIGN KEY ("facility_id","price_list_id") REFERENCES "public"."price_lists"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_item_fk" FOREIGN KEY ("facility_id","billable_item_id") REFERENCES "public"."billable_items"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_change_fk" FOREIGN KEY ("facility_id","price_change_id") REFERENCES "public"."price_changes"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "price_list_items_lookup_index" ON "price_list_items" USING btree ("price_list_id","billable_item_id","valid_from");--> statement-breakpoint
CREATE UNIQUE INDEX "price_lists_one_cash_list" ON "price_lists" USING btree ("facility_id") WHERE "price_lists"."kind" = 'cash';--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_known" CHECK ("audit_log"."action" IN ('facility.created', 'invitation.created', 'invitation.revoked', 'membership.granted', 'membership.roles_changed', 'membership.revoked', 'document.issued', 'document.voided', 'document.viewed', 'document.verified', 'patient.registered', 'patient.updated', 'patient.identifier_added', 'patient.viewed', 'patient.searched', 'encounter.opened', 'encounter.closed', 'encounter.cancelled', 'encounter.viewed', 'patient.admitted', 'patient.transferred', 'patient.discharged', 'ward.created', 'bed.created', 'billable_item.created', 'price_change.requested', 'price_change.approved', 'price_change.rejected', 'price_change.withdrawn'));