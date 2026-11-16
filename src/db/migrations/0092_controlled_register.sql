-- The ledger gets its (facility_id, id) key first, for the register's composite reference.
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_facility_id_id_key" UNIQUE("facility_id","id");--> statement-breakpoint
CREATE TABLE "controlled_drug_register" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry" bigint GENERATED ALWAYS AS IDENTITY (sequence name "controlled_drug_register_entry_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"facility_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"drug_code" text NOT NULL,
	"movement_id" uuid,
	"batch_id" uuid,
	"kind" text NOT NULL,
	"quantity" integer NOT NULL,
	"balance" integer NOT NULL,
	"patient_id" uuid,
	"prescribed_by" uuid,
	"prescriber_licence" text,
	"recorded_by" uuid,
	"recorder_licence" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "controlled_drug_register_movement_key" UNIQUE("movement_id"),
	CONSTRAINT "controlled_drug_register_kind_known" CHECK ("controlled_drug_register"."kind" IN ('brought_forward', 'receipt', 'receipt_reversed', 'transfer_out', 'transfer_in', 'dispense', 'dispense_cancelled', 'dispense_returned', 'adjustment')),
	CONSTRAINT "controlled_drug_register_balance_nonnegative" CHECK ("controlled_drug_register"."balance" >= 0),
	CONSTRAINT "controlled_drug_register_source" CHECK (("controlled_drug_register"."kind" = 'brought_forward') = ("controlled_drug_register"."movement_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "controlled_drug_register" ADD CONSTRAINT "controlled_drug_register_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_drug_register" ADD CONSTRAINT "controlled_drug_register_store_fk" FOREIGN KEY ("facility_id","store_id") REFERENCES "public"."stores"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_drug_register" ADD CONSTRAINT "controlled_drug_register_drug_fk" FOREIGN KEY ("drug_code") REFERENCES "public"."drug_catalogue"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_drug_register" ADD CONSTRAINT "controlled_drug_register_movement_fk" FOREIGN KEY ("facility_id","movement_id") REFERENCES "public"."stock_movements"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_drug_register" ADD CONSTRAINT "controlled_drug_register_batch_fk" FOREIGN KEY ("facility_id","batch_id") REFERENCES "public"."stock_batches"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_drug_register" ADD CONSTRAINT "controlled_drug_register_patient_fk" FOREIGN KEY ("facility_id","patient_id") REFERENCES "public"."patients"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_drug_register" ADD CONSTRAINT "controlled_drug_register_prescribed_by_fk" FOREIGN KEY ("facility_id","prescribed_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_drug_register" ADD CONSTRAINT "controlled_drug_register_recorded_by_fk" FOREIGN KEY ("facility_id","recorded_by") REFERENCES "public"."memberships"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "controlled_drug_register_page_index" ON "controlled_drug_register" USING btree ("facility_id","store_id","drug_code","entry");--> statement-breakpoint