-- Billable items and prices: row-level security, privileges, and the rules
-- that keep a price history true: no two prices for one item on one list at
-- once, a decided price change never changes, and a price that has ended
-- stays ended.

ALTER TABLE "billable_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billable_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billable_items"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

ALTER TABLE "price_lists" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "price_lists" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "price_lists"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

ALTER TABLE "price_changes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "price_changes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "price_changes"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

ALTER TABLE "price_change_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "price_change_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "price_change_lines"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

ALTER TABLE "price_list_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "price_list_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "price_list_items"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

-- An item's code is printed on past bills, so it never changes; its name may
-- be corrected, and an item retired.
GRANT SELECT, INSERT ON "billable_items" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("name", "is_active") ON "billable_items" TO hospital_app;
--> statement-breakpoint

GRANT SELECT, INSERT ON "price_lists", "price_change_lines" TO hospital_app;
--> statement-breakpoint

GRANT SELECT, INSERT ON "price_changes" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("status", "decided_by", "decided_at") ON "price_changes" TO hospital_app;
--> statement-breakpoint

-- A price is ended, never edited: a new price is a new row.
GRANT SELECT, INSERT ON "price_list_items" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("valid_to") ON "price_list_items" TO hospital_app;
--> statement-breakpoint

-- One price per item per list on any day (rule 21's lookup relies on it).
ALTER TABLE "price_list_items"
  ADD CONSTRAINT "price_list_items_no_overlap" EXCLUDE USING gist (
    "price_list_id" WITH =,
    "billable_item_id" WITH =,
    daterange("valid_from", "valid_to", '[)') WITH &&
  );
--> statement-breakpoint

-- A price's end only ever moves earlier: from open to a date, or to an
-- earlier date when a nearer change is approved. It never reopens or
-- lengthens, and the price's other columns never change.
CREATE FUNCTION price_list_items_end_once() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.valid_to IS NULL
    OR (OLD.valid_to IS NOT NULL AND NEW.valid_to > OLD.valid_to)
    OR NEW.unit_price_cents IS DISTINCT FROM OLD.unit_price_cents
    OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
    OR NEW.billable_item_id IS DISTINCT FROM OLD.billable_item_id
    OR NEW.price_list_id IS DISTINCT FROM OLD.price_list_id
  THEN
    RAISE EXCEPTION 'a price ends earlier or not at all, and is never edited'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER price_list_items_end_once
  BEFORE UPDATE ON "price_list_items"
  FOR EACH ROW EXECUTE FUNCTION price_list_items_end_once();
--> statement-breakpoint

-- A price change, once approved, rejected or withdrawn, is history.
CREATE FUNCTION price_changes_decided_once() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'a decided price change cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER price_changes_decided_once
  BEFORE UPDATE ON "price_changes"
  FOR EACH ROW EXECUTE FUNCTION price_changes_decided_once();
--> statement-breakpoint

-- A cash list for every facility onboarded before price lists existed.
INSERT INTO "price_lists" ("facility_id", "name", "kind")
SELECT "id", 'Cash', 'cash' FROM "facilities"
ON CONFLICT ("facility_id") WHERE "kind" = 'cash' DO NOTHING;
