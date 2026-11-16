-- Opens the controlled-drug register with the stock already held (CodeRabbit
-- on #22). Migrations 0092 to 0094 start each page at its first movement, and
-- the catalogue load brings stock forward only for a drug it newly schedules,
-- so a drug scheduled before the register existed would start at nought: the
-- next receipt of 5 onto 50 held would read 5. Each store holding such a
-- drug, with no page for it yet, gets a page opened with what it holds, as
-- the catalogue load does: the ledger held still meanwhile, row security off
-- so an owner unable to see every facility fails rather than skips them.
-- Safe to run again: a store with a page is left as it is.

SET LOCAL row_security = off;
--> statement-breakpoint
LOCK TABLE "stock_movements" IN SHARE MODE;
--> statement-breakpoint
INSERT INTO "controlled_drug_register" ("facility_id", "store_id", "drug_code", "kind", "quantity", "balance", "recorded_at")
SELECT m."facility_id", m."store_id", si."drug_code", 'brought_forward', sum(m."quantity"), sum(m."quantity"), clock_timestamp()
FROM "stock_movements" m
JOIN "stock_batches" b ON b."id" = m."batch_id"
JOIN "stock_items" si ON si."id" = b."stock_item_id"
WHERE si."drug_code" IN (SELECT "code" FROM "drug_catalogue" WHERE "controlled_schedule" IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM "controlled_drug_register" r
    WHERE r."facility_id" = m."facility_id" AND r."store_id" = m."store_id" AND r."drug_code" = si."drug_code"
  )
GROUP BY m."facility_id", m."store_id", si."drug_code"
HAVING sum(m."quantity") <> 0;
--> statement-breakpoint
SET LOCAL row_security = on;
