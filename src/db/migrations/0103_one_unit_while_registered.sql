-- One base unit for a drug while its register runs (CodeRabbit on #22).
-- Migration 0100 held a drug to one unit only while it was scheduled, but a
-- page, once open, records every movement of its drug though the schedule
-- is cleared (0094): an item set up then in another unit (ampoules beside
-- mL) would be added into the same balance. The rule now holds for a drug
-- that is scheduled, or has a register page in the facility.
--
-- The upgrade stops if a facility already counts such a drug in two units,
-- with the stock items held still and row security off, as in 0100.

LOCK TABLE "stock_items" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
SET LOCAL row_security = off;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "stock_items" si
    WHERE si."drug_code" IN (SELECT "code" FROM "drug_catalogue" WHERE "controlled_schedule" IS NOT NULL)
       OR EXISTS (SELECT 1 FROM "controlled_drug_register" r WHERE r."facility_id" = si."facility_id" AND r."drug_code" = si."drug_code")
    GROUP BY si."facility_id", si."drug_code" HAVING count(DISTINCT si."base_unit") > 1
  ) THEN
    RAISE EXCEPTION 'a facility counts one drug on its controlled-drug register in two base units: give its stock items one unit before this upgrade'
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;
--> statement-breakpoint
SET LOCAL row_security = on;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stock_items_one_unit_per_drug() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."drug_code" IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "drug_catalogue" d WHERE d."code" = NEW."drug_code" AND d."controlled_schedule" IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM "controlled_drug_register" r WHERE r."facility_id" = NEW."facility_id" AND r."drug_code" = NEW."drug_code") THEN
    RETURN NEW;
  END IF;
  -- Two items of one drug set up at once would each miss the other: one at a time, per drug.
  PERFORM pg_advisory_xact_lock(hashtextextended('stock_items_drug:' || NEW."facility_id"::text || ':' || NEW."drug_code", 0));
  IF EXISTS (
    SELECT 1 FROM "stock_items" s
    WHERE s."facility_id" = NEW."facility_id" AND s."drug_code" = NEW."drug_code" AND s."base_unit" <> NEW."base_unit" AND s."id" <> NEW."id"
  ) THEN
    RAISE EXCEPTION 'every stock item of a drug on the controlled-drug register is counted in one base unit'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_items_one_unit_per_drug';
  END IF;
  RETURN NEW;
END;
$$;
