CREATE TABLE "goods_received" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"number" text NOT NULL,
	"store_id" uuid NOT NULL,
	"supplier" text NOT NULL,
	"supplier_reference" text,
	"received_on" date NOT NULL,
	"received_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goods_received_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "goods_received_number_key" UNIQUE("facility_id","number"),
	CONSTRAINT "goods_received_text_present" CHECK (length(btrim("goods_received"."supplier")) > 0 AND ("goods_received"."supplier_reference" IS NULL OR length(btrim("goods_received"."supplier_reference")) > 0))
);
--> statement-breakpoint
CREATE TABLE "stock_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"goods_received_id" uuid NOT NULL,
	"line" integer NOT NULL,
	"batch_number" text,
	"expires_on" date,
	"quantity_received" integer NOT NULL,
	"pack_size" integer NOT NULL,
	"total_cost_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_batches_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "stock_batches_line_key" UNIQUE("goods_received_id","line"),
	CONSTRAINT "stock_batches_line_positive" CHECK ("stock_batches"."line" > 0),
	CONSTRAINT "stock_batches_quantity_positive" CHECK ("stock_batches"."quantity_received" > 0),
	CONSTRAINT "stock_batches_pack_size_positive" CHECK ("stock_batches"."pack_size" > 0),
	CONSTRAINT "stock_batches_cost_nonnegative" CHECK ("stock_batches"."total_cost_cents" >= 0),
	CONSTRAINT "stock_batches_batch_number_shape" CHECK ("stock_batches"."batch_number" IS NULL OR length(btrim("stock_batches"."batch_number")) BETWEEN 1 AND 40)
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"quantity" integer NOT NULL,
	"goods_received_id" uuid,
	"reason" text,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_kind_known" CHECK ("stock_movements"."kind" IN ('receipt', 'receipt_reversed')),
	CONSTRAINT "stock_movements_shape" CHECK (("stock_movements"."kind" = 'receipt' AND "stock_movements"."quantity" > 0 AND "stock_movements"."goods_received_id" IS NOT NULL AND "stock_movements"."reason" IS NULL)
      OR ("stock_movements"."kind" = 'receipt_reversed' AND "stock_movements"."quantity" < 0 AND "stock_movements"."goods_received_id" IS NOT NULL
          AND "stock_movements"."reason" IS NOT NULL AND length(btrim("stock_movements"."reason")) > 0))
);
--> statement-breakpoint
ALTER TABLE "number_series" DROP CONSTRAINT "number_series_kind_known";--> statement-breakpoint
ALTER TABLE "goods_received" ADD CONSTRAINT "goods_received_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_received" ADD CONSTRAINT "goods_received_store_fk" FOREIGN KEY ("facility_id","store_id") REFERENCES "public"."stores"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_received" ADD CONSTRAINT "goods_received_received_by_fk" FOREIGN KEY ("facility_id","received_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_stock_item_fk" FOREIGN KEY ("facility_id","stock_item_id") REFERENCES "public"."stock_items"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_goods_received_fk" FOREIGN KEY ("facility_id","goods_received_id") REFERENCES "public"."goods_received"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_store_fk" FOREIGN KEY ("facility_id","store_id") REFERENCES "public"."stores"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_batch_fk" FOREIGN KEY ("facility_id","batch_id") REFERENCES "public"."stock_batches"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_goods_received_fk" FOREIGN KEY ("facility_id","goods_received_id") REFERENCES "public"."goods_received"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_recorded_by_fk" FOREIGN KEY ("facility_id","recorded_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goods_received_store_index" ON "goods_received" USING btree ("facility_id","store_id","received_on");--> statement-breakpoint
CREATE INDEX "stock_batches_item_expiry_index" ON "stock_batches" USING btree ("facility_id","stock_item_id","expires_on");--> statement-breakpoint
CREATE INDEX "stock_movements_store_batch_index" ON "stock_movements" USING btree ("facility_id","store_id","batch_id");--> statement-breakpoint
CREATE INDEX "stock_movements_batch_index" ON "stock_movements" USING btree ("facility_id","batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_one_receipt" ON "stock_movements" USING btree ("batch_id") WHERE "stock_movements"."kind" = 'receipt';--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_one_receipt_reversal" ON "stock_movements" USING btree ("batch_id") WHERE "stock_movements"."kind" = 'receipt_reversed';--> statement-breakpoint
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_kind_known" CHECK ("number_series"."kind" IN ('outpatient', 'inpatient', 'admission', 'receipt', 'invoice', 'credit_note', 'refund', 'prescription', 'lab_accession', 'lab_report', 'goods_received'));