-- Each specimen's tests keep the analytes they had when it was taken. Rows
-- from before this column take the analytes in use now, which is the best
-- that can be recovered; the write-once trigger is held off for this one
-- backfill.
ALTER TABLE "specimen_tests" ADD COLUMN "analyte_ids" uuid[];--> statement-breakpoint
ALTER TABLE "specimen_tests" DISABLE TRIGGER "specimen_tests_written_once";--> statement-breakpoint
UPDATE "specimen_tests" st SET "analyte_ids" = coalesce((
  SELECT array_agg(a."id" ORDER BY a."position")
  FROM "order_items" i
  JOIN "lab_analytes" a ON a."facility_id" = i."facility_id" AND a."lab_test_id" = i."lab_test_id" AND a."is_active"
  WHERE i."facility_id" = st."facility_id" AND i."id" = st."order_item_id"
), '{}');--> statement-breakpoint
ALTER TABLE "specimen_tests" ENABLE TRIGGER "specimen_tests_written_once";--> statement-breakpoint
ALTER TABLE "specimen_tests" ALTER COLUMN "analyte_ids" SET NOT NULL;
