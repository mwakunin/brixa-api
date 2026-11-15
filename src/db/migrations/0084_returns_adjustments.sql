CREATE TABLE "dispense_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"dispense_line_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"reason" text NOT NULL,
	"fit_for_resale" boolean NOT NULL,
	"status" text NOT NULL,
	"received_by" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"invoice_adjustment_id" uuid,
	CONSTRAINT "dispense_returns_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "dispense_returns_status_known" CHECK ("dispense_returns"."status" IN ('done', 'pending', 'rejected')),
	CONSTRAINT "dispense_returns_quantity_positive" CHECK ("dispense_returns"."quantity" > 0),
	CONSTRAINT "dispense_returns_reason_present" CHECK (length(btrim("dispense_returns"."reason")) > 0),
	CONSTRAINT "dispense_returns_lifecycle" CHECK (("dispense_returns"."decided_by" IS NULL) = ("dispense_returns"."decided_at" IS NULL)
      AND (("dispense_returns"."fit_for_resale" AND "dispense_returns"."status" = 'done' AND "dispense_returns"."decided_by" IS NULL)
        OR (NOT "dispense_returns"."fit_for_resale" AND "dispense_returns"."status" = 'pending' AND "dispense_returns"."decided_by" IS NULL)
        OR (NOT "dispense_returns"."fit_for_resale" AND "dispense_returns"."status" IN ('done', 'rejected') AND "dispense_returns"."decided_by" IS NOT NULL AND "dispense_returns"."decided_by" <> "dispense_returns"."received_by")))
);
--> statement-breakpoint
CREATE TABLE "stock_adjustment_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"adjustment_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"value_cents" integer NOT NULL,
	CONSTRAINT "stock_adjustment_lines_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "stock_adjustment_lines_batch_key" UNIQUE("adjustment_id","batch_id"),
	CONSTRAINT "stock_adjustment_lines_quantity_nonzero" CHECK ("stock_adjustment_lines"."quantity" <> 0)
);
--> statement-breakpoint
CREATE TABLE "stock_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	CONSTRAINT "stock_adjustments_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "stock_adjustments_kind_known" CHECK ("stock_adjustments"."kind" IN ('expired', 'damaged', 'lost', 'found', 'correction')),
	CONSTRAINT "stock_adjustments_status_known" CHECK ("stock_adjustments"."status" IN ('pending', 'approved', 'rejected', 'withdrawn')),
	CONSTRAINT "stock_adjustments_reason_present" CHECK (length(btrim("stock_adjustments"."reason")) > 0),
	CONSTRAINT "stock_adjustments_decision" CHECK (("stock_adjustments"."decided_by" IS NULL) = ("stock_adjustments"."decided_at" IS NULL)
      AND ("stock_adjustments"."status" = 'pending') = ("stock_adjustments"."decided_by" IS NULL)
      AND ("stock_adjustments"."decided_by" IS NULL OR ("stock_adjustments"."status" = 'withdrawn') = ("stock_adjustments"."decided_by" = "stock_adjustments"."requested_by")))
);
--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_kind_known";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_shape";--> statement-breakpoint
DROP INDEX "charges_one_per_dispense_line";--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "dispense_return_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "stock_adjustment_line_id" uuid;--> statement-breakpoint
ALTER TABLE "dispense_returns" ADD CONSTRAINT "dispense_returns_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_returns" ADD CONSTRAINT "dispense_returns_line_fk" FOREIGN KEY ("facility_id","dispense_line_id") REFERENCES "public"."dispense_lines"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_returns" ADD CONSTRAINT "dispense_returns_received_by_fk" FOREIGN KEY ("facility_id","received_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_returns" ADD CONSTRAINT "dispense_returns_decided_by_fk" FOREIGN KEY ("facility_id","decided_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_returns" ADD CONSTRAINT "dispense_returns_adjustment_fk" FOREIGN KEY ("facility_id","invoice_adjustment_id") REFERENCES "public"."invoice_adjustments"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_adjustment_fk" FOREIGN KEY ("facility_id","adjustment_id") REFERENCES "public"."stock_adjustments"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_batch_fk" FOREIGN KEY ("facility_id","batch_id") REFERENCES "public"."stock_batches"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_store_fk" FOREIGN KEY ("facility_id","store_id") REFERENCES "public"."stores"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_requested_by_fk" FOREIGN KEY ("facility_id","requested_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_decided_by_fk" FOREIGN KEY ("facility_id","decided_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dispense_returns_line_index" ON "dispense_returns" USING btree ("facility_id","dispense_line_id");--> statement-breakpoint
CREATE INDEX "dispense_returns_status_index" ON "dispense_returns" USING btree ("facility_id","status");--> statement-breakpoint
CREATE INDEX "stock_adjustments_status_index" ON "stock_adjustments" USING btree ("facility_id","status");--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_dispense_return_fk" FOREIGN KEY ("facility_id","dispense_return_id") REFERENCES "public"."dispense_returns"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_adjustment_line_fk" FOREIGN KEY ("facility_id","stock_adjustment_line_id") REFERENCES "public"."stock_adjustment_lines"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "charges_one_standing_per_dispense_line" ON "charges" USING btree ("dispense_line_id") WHERE "charges"."dispense_line_id" IS NOT NULL AND "charges"."cancelled_at" IS NULL;--> statement-breakpoint
CREATE INDEX "stock_movements_dispense_return_index" ON "stock_movements" USING btree ("facility_id","dispense_return_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_one_adjustment" ON "stock_movements" USING btree ("stock_adjustment_line_id") WHERE "stock_movements"."kind" = 'adjustment';--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_kind_known" CHECK ("stock_movements"."kind" IN ('receipt', 'receipt_reversed', 'transfer_out', 'transfer_in', 'dispense', 'dispense_cancelled', 'dispense_returned', 'adjustment'));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_shape" CHECK (num_nonnulls("stock_movements"."goods_received_id", "stock_movements"."transfer_id", "stock_movements"."dispense_line_id", "stock_movements"."dispense_return_id", "stock_movements"."stock_adjustment_line_id") = 1
      AND (("stock_movements"."kind" = 'receipt' AND "stock_movements"."quantity" > 0 AND "stock_movements"."goods_received_id" IS NOT NULL AND "stock_movements"."reason" IS NULL)
        OR ("stock_movements"."kind" = 'receipt_reversed' AND "stock_movements"."quantity" < 0 AND "stock_movements"."goods_received_id" IS NOT NULL
            AND "stock_movements"."reason" IS NOT NULL AND length(btrim("stock_movements"."reason")) > 0)
        OR ("stock_movements"."kind" = 'transfer_out' AND "stock_movements"."quantity" < 0 AND "stock_movements"."transfer_id" IS NOT NULL AND "stock_movements"."reason" IS NULL)
        OR ("stock_movements"."kind" = 'transfer_in' AND "stock_movements"."quantity" > 0 AND "stock_movements"."transfer_id" IS NOT NULL AND "stock_movements"."reason" IS NULL)
        OR ("stock_movements"."kind" = 'dispense' AND "stock_movements"."quantity" < 0 AND "stock_movements"."dispense_line_id" IS NOT NULL AND "stock_movements"."reason" IS NULL)
        OR ("stock_movements"."kind" = 'dispense_cancelled' AND "stock_movements"."quantity" > 0 AND "stock_movements"."dispense_line_id" IS NOT NULL AND "stock_movements"."reason" IS NULL)
        OR ("stock_movements"."kind" = 'dispense_returned' AND "stock_movements"."quantity" > 0 AND "stock_movements"."dispense_return_id" IS NOT NULL AND "stock_movements"."reason" IS NULL)
        OR ("stock_movements"."kind" = 'adjustment' AND "stock_movements"."quantity" <> 0 AND "stock_movements"."stock_adjustment_line_id" IS NOT NULL AND "stock_movements"."reason" IS NULL)));