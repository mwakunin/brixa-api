-- One controlled drug, one base unit, in a facility (CodeRabbit on #22). The
-- controlled-drug register keeps a balance per drug and store, adding each
-- movement's quantity, so two brands of one drug counted in different units
-- (mL and ampoule) would add up to a number in neither. Every stock item of a
-- scheduled drug, retired ones too, is now counted in the same unit, so the
-- register's history never mixes them. Other drugs may still be stocked in
-- two (bottles, and loose mL), as dispensing allows; the catalogue load
-- refuses to schedule one a facility counts in two.
--
-- The upgrade stops if a facility already counts a scheduled drug in two.
-- Row security is off around that check, so an owner unable to see every
-- facility fails it rather than passes it.

SET LOCAL row_security = off;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "stock_items"
    WHERE "drug_code" IN (SELECT "code" FROM "drug_catalogue" WHERE "controlled_schedule" IS NOT NULL)
    GROUP BY "facility_id", "drug_code" HAVING count(DISTINCT "base_unit") > 1
  ) THEN
    RAISE EXCEPTION 'a facility counts one controlled drug in two base units: give its stock items one unit before this upgrade'
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;
--> statement-breakpoint
SET LOCAL row_security = on;
--> statement-breakpoint
CREATE FUNCTION stock_items_one_unit_per_drug() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."drug_code" IS NULL OR NOT EXISTS (
    SELECT 1 FROM "drug_catalogue" d WHERE d."code" = NEW."drug_code" AND d."controlled_schedule" IS NOT NULL
  ) THEN
    RETURN NEW;
  END IF;
  -- Two items of one drug set up at once would each miss the other: one at a time, per drug.
  PERFORM pg_advisory_xact_lock(hashtextextended('stock_items_drug:' || NEW."facility_id"::text || ':' || NEW."drug_code", 0));
  IF EXISTS (
    SELECT 1 FROM "stock_items" s
    WHERE s."facility_id" = NEW."facility_id" AND s."drug_code" = NEW."drug_code" AND s."base_unit" <> NEW."base_unit" AND s."id" <> NEW."id"
  ) THEN
    RAISE EXCEPTION 'every stock item of a controlled drug is counted in one base unit'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_items_one_unit_per_drug';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stock_items_one_unit_per_drug
  BEFORE INSERT OR UPDATE OF "drug_code", "base_unit" ON "stock_items"
  FOR EACH ROW EXECUTE FUNCTION stock_items_one_unit_per_drug();
