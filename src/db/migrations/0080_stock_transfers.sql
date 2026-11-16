CREATE TABLE "stock_transfer_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"transfer_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"quantity_sent" integer NOT NULL,
	"quantity_received" integer,
	CONSTRAINT "stock_transfer_batches_batch_key" UNIQUE("transfer_id","batch_id"),
	CONSTRAINT "stock_transfer_batches_quantities" CHECK ("stock_transfer_batches"."quantity_sent" > 0 AND ("stock_transfer_batches"."quantity_received" IS NULL OR "stock_transfer_batches"."quantity_received" BETWEEN 0 AND "stock_transfer_batches"."quantity_sent"))
);
--> statement-breakpoint
CREATE TABLE "stock_transfer_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"transfer_id" uuid NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"quantity_requested" integer NOT NULL,
	CONSTRAINT "stock_transfer_items_item_key" UNIQUE("transfer_id","stock_item_id"),
	CONSTRAINT "stock_transfer_items_quantity_positive" CHECK ("stock_transfer_items"."quantity_requested" > 0)
);
--> statement-breakpoint
CREATE TABLE "stock_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"number" text NOT NULL,
	"from_store_id" uuid NOT NULL,
	"to_store_id" uuid NOT NULL,
	"status" text NOT NULL,
	"requested_by" uuid,
	"requested_at" timestamp with time zone,
	"sent_by" uuid,
	"sent_at" timestamp with time zone,
	"received_by" uuid,
	"received_at" timestamp with time zone,
	"shortfall_reason" text,
	"shortfall_accepted_by" uuid,
	"shortfall_accepted_at" timestamp with time zone,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_transfers_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "stock_transfers_number_key" UNIQUE("facility_id","number"),
	CONSTRAINT "stock_transfers_status_known" CHECK ("stock_transfers"."status" IN ('requested', 'sent', 'received', 'cancelled', 'declined')),
	CONSTRAINT "stock_transfers_two_stores" CHECK ("stock_transfers"."from_store_id" <> "stock_transfers"."to_store_id"),
	CONSTRAINT "stock_transfers_lifecycle" CHECK (("stock_transfers"."requested_by" IS NULL) = ("stock_transfers"."requested_at" IS NULL)
      AND ("stock_transfers"."sent_by" IS NULL) = ("stock_transfers"."sent_at" IS NULL)
      AND ("stock_transfers"."received_by" IS NULL) = ("stock_transfers"."received_at" IS NULL)
      AND ("stock_transfers"."closed_by" IS NULL) = ("stock_transfers"."closed_at" IS NULL) AND ("stock_transfers"."closed_by" IS NULL) = ("stock_transfers"."close_reason" IS NULL)
      AND ("stock_transfers"."close_reason" IS NULL OR length(btrim("stock_transfers"."close_reason")) > 0)
      AND CASE "stock_transfers"."status"
        WHEN 'requested' THEN "stock_transfers"."requested_by" IS NOT NULL AND "stock_transfers"."sent_by" IS NULL AND "stock_transfers"."received_by" IS NULL AND "stock_transfers"."closed_by" IS NULL
        WHEN 'sent' THEN "stock_transfers"."sent_by" IS NOT NULL AND "stock_transfers"."received_by" IS NULL AND "stock_transfers"."closed_by" IS NULL
        WHEN 'received' THEN "stock_transfers"."sent_by" IS NOT NULL AND "stock_transfers"."received_by" IS NOT NULL AND "stock_transfers"."closed_by" IS NULL
        ELSE "stock_transfers"."requested_by" IS NOT NULL AND "stock_transfers"."sent_by" IS NULL AND "stock_transfers"."received_by" IS NULL AND "stock_transfers"."closed_by" IS NOT NULL
      END),
	CONSTRAINT "stock_transfers_received_by_another" CHECK ("stock_transfers"."received_by" IS NULL OR "stock_transfers"."received_by" <> "stock_transfers"."sent_by"),
	CONSTRAINT "stock_transfers_shortfall" CHECK (("stock_transfers"."shortfall_reason" IS NULL OR ("stock_transfers"."received_by" IS NOT NULL AND length(btrim("stock_transfers"."shortfall_reason")) > 0))
      AND ("stock_transfers"."shortfall_accepted_by" IS NULL) = ("stock_transfers"."shortfall_accepted_at" IS NULL)
      AND ("stock_transfers"."shortfall_accepted_by" IS NULL OR ("stock_transfers"."shortfall_reason" IS NOT NULL AND "stock_transfers"."shortfall_accepted_by" <> "stock_transfers"."received_by")))
);
--> statement-breakpoint
ALTER TABLE "number_series" DROP CONSTRAINT "number_series_kind_known";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_kind_known";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_shape";--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "transfer_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_transfer_batches" ADD CONSTRAINT "stock_transfer_batches_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_batches" ADD CONSTRAINT "stock_transfer_batches_transfer_fk" FOREIGN KEY ("facility_id","transfer_id") REFERENCES "public"."stock_transfers"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_batches" ADD CONSTRAINT "stock_transfer_batches_batch_fk" FOREIGN KEY ("facility_id","batch_id") REFERENCES "public"."stock_batches"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_transfer_fk" FOREIGN KEY ("facility_id","transfer_id") REFERENCES "public"."stock_transfers"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_stock_item_fk" FOREIGN KEY ("facility_id","stock_item_id") REFERENCES "public"."stock_items"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_from_store_fk" FOREIGN KEY ("facility_id","from_store_id") REFERENCES "public"."stores"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_store_fk" FOREIGN KEY ("facility_id","to_store_id") REFERENCES "public"."stores"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_requested_by_fk" FOREIGN KEY ("facility_id","requested_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_sent_by_fk" FOREIGN KEY ("facility_id","sent_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_received_by_fk" FOREIGN KEY ("facility_id","received_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_shortfall_accepted_by_fk" FOREIGN KEY ("facility_id","shortfall_accepted_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_closed_by_fk" FOREIGN KEY ("facility_id","closed_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_transfer_batches_batch_index" ON "stock_transfer_batches" USING btree ("facility_id","batch_id");--> statement-breakpoint
CREATE INDEX "stock_transfers_from_index" ON "stock_transfers" USING btree ("facility_id","from_store_id","status");--> statement-breakpoint
CREATE INDEX "stock_transfers_to_index" ON "stock_transfers" USING btree ("facility_id","to_store_id","status");--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_transfer_fk" FOREIGN KEY ("facility_id","transfer_id") REFERENCES "public"."stock_transfers"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_one_transfer_out" ON "stock_movements" USING btree ("transfer_id","batch_id") WHERE "stock_movements"."kind" = 'transfer_out';--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_one_transfer_in" ON "stock_movements" USING btree ("transfer_id","batch_id") WHERE "stock_movements"."kind" = 'transfer_in';--> statement-breakpoint
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_kind_known" CHECK ("number_series"."kind" IN ('outpatient', 'inpatient', 'admission', 'receipt', 'invoice', 'credit_note', 'refund', 'prescription', 'lab_accession', 'lab_report', 'goods_received', 'stock_transfer'));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_kind_known" CHECK ("stock_movements"."kind" IN ('receipt', 'receipt_reversed', 'transfer_out', 'transfer_in'));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_shape" CHECK (("stock_movements"."kind" = 'receipt' AND "stock_movements"."quantity" > 0 AND "stock_movements"."goods_received_id" IS NOT NULL AND "stock_movements"."transfer_id" IS NULL AND "stock_movements"."reason" IS NULL)
      OR ("stock_movements"."kind" = 'receipt_reversed' AND "stock_movements"."quantity" < 0 AND "stock_movements"."goods_received_id" IS NOT NULL AND "stock_movements"."transfer_id" IS NULL
          AND "stock_movements"."reason" IS NOT NULL AND length(btrim("stock_movements"."reason")) > 0)
      OR ("stock_movements"."kind" = 'transfer_out' AND "stock_movements"."quantity" < 0 AND "stock_movements"."transfer_id" IS NOT NULL AND "stock_movements"."goods_received_id" IS NULL AND "stock_movements"."reason" IS NULL)
      OR ("stock_movements"."kind" = 'transfer_in' AND "stock_movements"."quantity" > 0 AND "stock_movements"."transfer_id" IS NOT NULL AND "stock_movements"."goods_received_id" IS NULL AND "stock_movements"."reason" IS NULL));