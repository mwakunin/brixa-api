CREATE TABLE "reorder_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"level" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reorder_levels_store_item_key" UNIQUE("facility_id","store_id","stock_item_id"),
	CONSTRAINT "reorder_levels_level_nonnegative" CHECK ("reorder_levels"."level" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"billable_item_id" uuid NOT NULL,
	"drug_code" text,
	"base_unit" text NOT NULL,
	"pack_size" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_items_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "stock_items_billable_item_key" UNIQUE("facility_id","billable_item_id"),
	CONSTRAINT "stock_items_base_unit_shape" CHECK (length(btrim("stock_items"."base_unit")) BETWEEN 1 AND 20),
	CONSTRAINT "stock_items_pack_size_positive" CHECK ("stock_items"."pack_size" > 0)
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stores_facility_id_id_key" UNIQUE("facility_id","id"),
	CONSTRAINT "stores_facility_id_name_key" UNIQUE("facility_id","name"),
	CONSTRAINT "stores_name_present" CHECK (length(btrim("stores"."name")) > 0),
	CONSTRAINT "stores_kind_known" CHECK ("stores"."kind" IN ('main', 'pharmacy', 'ward', 'other'))
);
--> statement-breakpoint
ALTER TABLE "reorder_levels" ADD CONSTRAINT "reorder_levels_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reorder_levels" ADD CONSTRAINT "reorder_levels_store_fk" FOREIGN KEY ("facility_id","store_id") REFERENCES "public"."stores"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reorder_levels" ADD CONSTRAINT "reorder_levels_stock_item_fk" FOREIGN KEY ("facility_id","stock_item_id") REFERENCES "public"."stock_items"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_billable_item_fk" FOREIGN KEY ("facility_id","billable_item_id") REFERENCES "public"."billable_items"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_drug_fk" FOREIGN KEY ("drug_code") REFERENCES "public"."drug_catalogue"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reorder_levels_stock_item_index" ON "reorder_levels" USING btree ("facility_id","stock_item_id");--> statement-breakpoint
CREATE INDEX "stock_items_drug_index" ON "stock_items" USING btree ("facility_id","drug_code");