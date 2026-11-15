CREATE TABLE "dispense_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"dispense_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"completes" boolean NOT NULL,
	CONSTRAINT "dispense_lines_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "dispense_lines_medicine_key" UNIQUE("dispense_id","order_item_id"),
	CONSTRAINT "dispense_lines_quantity_positive" CHECK ("dispense_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "dispenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"status" text NOT NULL,
	"prepared_by" uuid NOT NULL,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"handed_over_by" uuid,
	"handed_over_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	CONSTRAINT "dispenses_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "dispenses_status_known" CHECK ("dispenses"."status" IN ('prepared', 'handed_over', 'cancelled')),
	CONSTRAINT "dispenses_lifecycle" CHECK (("dispenses"."status" = 'prepared' AND num_nonnulls("dispenses"."handed_over_by", "dispenses"."handed_over_at", "dispenses"."cancelled_by", "dispenses"."cancelled_at", "dispenses"."cancellation_reason") = 0)
      OR ("dispenses"."status" = 'handed_over' AND "dispenses"."handed_over_by" IS NOT NULL AND "dispenses"."handed_over_at" IS NOT NULL
          AND num_nonnulls("dispenses"."cancelled_by", "dispenses"."cancelled_at", "dispenses"."cancellation_reason") = 0)
      OR ("dispenses"."status" = 'cancelled' AND "dispenses"."cancelled_by" IS NOT NULL AND "dispenses"."cancelled_at" IS NOT NULL
          AND "dispenses"."cancellation_reason" IS NOT NULL AND length(btrim("dispenses"."cancellation_reason")) > 0
          AND num_nonnulls("dispenses"."handed_over_by", "dispenses"."handed_over_at") = 0))
);
--> statement-breakpoint
CREATE TABLE "medicines_not_supplied" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "medicines_not_supplied_order_item_key" UNIQUE("order_item_id"),
	CONSTRAINT "medicines_not_supplied_reason_known" CHECK ("medicines_not_supplied"."reason" IN ('out_of_stock', 'patient_declined', 'buying_elsewhere', 'other')),
	CONSTRAINT "medicines_not_supplied_note" CHECK (("medicines_not_supplied"."note" IS NULL OR length(btrim("medicines_not_supplied"."note")) > 0) AND ("medicines_not_supplied"."reason" <> 'other' OR "medicines_not_supplied"."note" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "charges" DROP CONSTRAINT "charges_source_or_reason";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_kind_known";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_shape";--> statement-breakpoint
ALTER TABLE "charges" ADD COLUMN "dispense_line_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "dispense_line_id" uuid;--> statement-breakpoint
ALTER TABLE "dispense_lines" ADD CONSTRAINT "dispense_lines_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_lines" ADD CONSTRAINT "dispense_lines_dispense_fk" FOREIGN KEY ("facility_id","dispense_id") REFERENCES "public"."dispenses"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_lines" ADD CONSTRAINT "dispense_lines_order_item_fk" FOREIGN KEY ("facility_id","order_item_id") REFERENCES "public"."order_items"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_lines" ADD CONSTRAINT "dispense_lines_stock_item_fk" FOREIGN KEY ("facility_id","stock_item_id") REFERENCES "public"."stock_items"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispenses" ADD CONSTRAINT "dispenses_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispenses" ADD CONSTRAINT "dispenses_encounter_fk" FOREIGN KEY ("facility_id","encounter_id") REFERENCES "public"."encounters"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispenses" ADD CONSTRAINT "dispenses_order_fk" FOREIGN KEY ("facility_id","order_id") REFERENCES "public"."orders"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispenses" ADD CONSTRAINT "dispenses_store_fk" FOREIGN KEY ("facility_id","store_id") REFERENCES "public"."stores"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispenses" ADD CONSTRAINT "dispenses_prepared_by_fk" FOREIGN KEY ("facility_id","prepared_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispenses" ADD CONSTRAINT "dispenses_handed_over_by_fk" FOREIGN KEY ("facility_id","handed_over_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispenses" ADD CONSTRAINT "dispenses_cancelled_by_fk" FOREIGN KEY ("facility_id","cancelled_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicines_not_supplied" ADD CONSTRAINT "medicines_not_supplied_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicines_not_supplied" ADD CONSTRAINT "medicines_not_supplied_order_item_fk" FOREIGN KEY ("facility_id","order_item_id") REFERENCES "public"."order_items"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicines_not_supplied" ADD CONSTRAINT "medicines_not_supplied_recorded_by_fk" FOREIGN KEY ("facility_id","recorded_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dispense_lines_order_item_index" ON "dispense_lines" USING btree ("facility_id","order_item_id");--> statement-breakpoint
CREATE INDEX "dispenses_order_index" ON "dispenses" USING btree ("facility_id","order_id");--> statement-breakpoint
CREATE INDEX "dispenses_status_index" ON "dispenses" USING btree ("facility_id","status");--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_dispense_line_fk" FOREIGN KEY ("facility_id","dispense_line_id") REFERENCES "public"."dispense_lines"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_dispense_line_fk" FOREIGN KEY ("facility_id","dispense_line_id") REFERENCES "public"."dispense_lines"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "charges_one_per_dispense_line" ON "charges" USING btree ("dispense_line_id") WHERE "charges"."dispense_line_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_one_dispense" ON "stock_movements" USING btree ("dispense_line_id","batch_id") WHERE "stock_movements"."kind" = 'dispense';--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_one_dispense_cancelled" ON "stock_movements" USING btree ("dispense_line_id","batch_id") WHERE "stock_movements"."kind" = 'dispense_cancelled';--> statement-breakpoint
CREATE INDEX "stock_movements_dispense_line_index" ON "stock_movements" USING btree ("facility_id","dispense_line_id");--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_source_or_reason" CHECK (num_nonnulls("charges"."bed_stay_id", "charges"."queue_entry_id", "charges"."order_item_id", "charges"."dispense_line_id") <= 1
      AND ((num_nonnulls("charges"."bed_stay_id", "charges"."queue_entry_id", "charges"."order_item_id", "charges"."dispense_line_id") = 0) = ("charges"."manual_reason" IS NOT NULL AND length(btrim("charges"."manual_reason")) > 0)));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_kind_known" CHECK ("stock_movements"."kind" IN ('receipt', 'receipt_reversed', 'transfer_out', 'transfer_in', 'dispense', 'dispense_cancelled'));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_shape" CHECK (num_nonnulls("stock_movements"."goods_received_id", "stock_movements"."transfer_id", "stock_movements"."dispense_line_id") = 1
      AND (("stock_movements"."kind" = 'receipt' AND "stock_movements"."quantity" > 0 AND "stock_movements"."goods_received_id" IS NOT NULL AND "stock_movements"."reason" IS NULL)
        OR ("stock_movements"."kind" = 'receipt_reversed' AND "stock_movements"."quantity" < 0 AND "stock_movements"."goods_received_id" IS NOT NULL
            AND "stock_movements"."reason" IS NOT NULL AND length(btrim("stock_movements"."reason")) > 0)
        OR ("stock_movements"."kind" = 'transfer_out' AND "stock_movements"."quantity" < 0 AND "stock_movements"."transfer_id" IS NOT NULL AND "stock_movements"."reason" IS NULL)
        OR ("stock_movements"."kind" = 'transfer_in' AND "stock_movements"."quantity" > 0 AND "stock_movements"."transfer_id" IS NOT NULL AND "stock_movements"."reason" IS NULL)
        OR ("stock_movements"."kind" = 'dispense' AND "stock_movements"."quantity" < 0 AND "stock_movements"."dispense_line_id" IS NOT NULL AND "stock_movements"."reason" IS NULL)
        OR ("stock_movements"."kind" = 'dispense_cancelled' AND "stock_movements"."quantity" > 0 AND "stock_movements"."dispense_line_id" IS NOT NULL AND "stock_movements"."reason" IS NULL)));