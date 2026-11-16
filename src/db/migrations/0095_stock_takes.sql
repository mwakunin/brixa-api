CREATE TABLE "stock_take_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"stock_take_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"counted_quantity" integer,
	"counted_at" timestamp with time zone,
	"counted_by" uuid,
	"expected_quantity" integer,
	CONSTRAINT "stock_take_lines_batch_key" UNIQUE("stock_take_id","batch_id"),
	CONSTRAINT "stock_take_lines_counted" CHECK (("stock_take_lines"."counted_quantity" IS NULL) = ("stock_take_lines"."counted_at" IS NULL) AND ("stock_take_lines"."counted_at" IS NULL) = ("stock_take_lines"."counted_by" IS NULL) AND ("stock_take_lines"."counted_quantity" IS NULL OR "stock_take_lines"."counted_quantity" >= 0))
);
--> statement-breakpoint
CREATE TABLE "stock_takes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"number" text NOT NULL,
	"store_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"status" text NOT NULL,
	"opened_by" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone,
	"adjustment_id" uuid,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	CONSTRAINT "stock_takes_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "stock_takes_number_key" UNIQUE("facility_id","number"),
	CONSTRAINT "stock_takes_scope_known" CHECK ("stock_takes"."scope" IN ('store', 'items')),
	CONSTRAINT "stock_takes_status_known" CHECK ("stock_takes"."status" IN ('counting', 'submitted', 'cancelled')),
	CONSTRAINT "stock_takes_lifecycle" CHECK (("stock_takes"."status" = 'counting' AND num_nonnulls("stock_takes"."submitted_by", "stock_takes"."submitted_at", "stock_takes"."adjustment_id", "stock_takes"."cancelled_by", "stock_takes"."cancelled_at", "stock_takes"."cancellation_reason") = 0)
      OR ("stock_takes"."status" = 'submitted' AND "stock_takes"."submitted_by" IS NOT NULL AND "stock_takes"."submitted_at" IS NOT NULL AND num_nonnulls("stock_takes"."cancelled_by", "stock_takes"."cancelled_at", "stock_takes"."cancellation_reason") = 0)
      OR ("stock_takes"."status" = 'cancelled' AND "stock_takes"."cancelled_by" IS NOT NULL AND "stock_takes"."cancelled_at" IS NOT NULL AND length(btrim("stock_takes"."cancellation_reason")) > 0
          AND num_nonnulls("stock_takes"."submitted_by", "stock_takes"."submitted_at", "stock_takes"."adjustment_id") = 0))
);
--> statement-breakpoint
ALTER TABLE "number_series" DROP CONSTRAINT "number_series_kind_known";--> statement-breakpoint
ALTER TABLE "stock_take_lines" ADD CONSTRAINT "stock_take_lines_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_take_lines" ADD CONSTRAINT "stock_take_lines_take_fk" FOREIGN KEY ("facility_id","stock_take_id") REFERENCES "public"."stock_takes"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_take_lines" ADD CONSTRAINT "stock_take_lines_batch_fk" FOREIGN KEY ("facility_id","batch_id") REFERENCES "public"."stock_batches"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_take_lines" ADD CONSTRAINT "stock_take_lines_counted_by_fk" FOREIGN KEY ("facility_id","counted_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_takes" ADD CONSTRAINT "stock_takes_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_takes" ADD CONSTRAINT "stock_takes_store_fk" FOREIGN KEY ("facility_id","store_id") REFERENCES "public"."stores"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_takes" ADD CONSTRAINT "stock_takes_opened_by_fk" FOREIGN KEY ("facility_id","opened_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_takes" ADD CONSTRAINT "stock_takes_submitted_by_fk" FOREIGN KEY ("facility_id","submitted_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_takes" ADD CONSTRAINT "stock_takes_cancelled_by_fk" FOREIGN KEY ("facility_id","cancelled_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_takes" ADD CONSTRAINT "stock_takes_adjustment_fk" FOREIGN KEY ("facility_id","adjustment_id") REFERENCES "public"."stock_adjustments"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_takes_one_open_per_store" ON "stock_takes" USING btree ("facility_id","store_id") WHERE "stock_takes"."status" = 'counting';--> statement-breakpoint
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_kind_known" CHECK ("number_series"."kind" IN ('outpatient', 'inpatient', 'admission', 'receipt', 'invoice', 'credit_note', 'refund', 'prescription', 'lab_accession', 'lab_report', 'goods_received', 'stock_transfer', 'stock_take'));