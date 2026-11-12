ALTER TABLE "order_items" ADD COLUMN "specimen_type" text;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_specimen_type_known" CHECK ("order_items"."specimen_type" IN ('blood', 'urine', 'stool', 'sputum', 'swab', 'csf', 'body_fluid', 'other'));--> statement-breakpoint
-- Lab items ordered before this column existed take their test's type as
-- it is now; the lifecycle trigger, which freezes every column but the
-- lifecycle ones, is held off for this one backfill.
ALTER TABLE "order_items" DISABLE TRIGGER "order_items_lifecycle";--> statement-breakpoint
UPDATE "order_items" i SET "specimen_type" = t."specimen_type"
  FROM "lab_tests" t
  WHERE t."facility_id" = i."facility_id" AND t."id" = i."lab_test_id";--> statement-breakpoint
ALTER TABLE "order_items" ENABLE TRIGGER "order_items_lifecycle";--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_specimen_type_of_a_test" CHECK (("order_items"."lab_test_id" IS NULL) = ("order_items"."specimen_type" IS NULL));