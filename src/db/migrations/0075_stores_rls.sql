-- Stores, stock items and reorder levels (P4 slice 1a): row-level security,
-- privileges, and the audit actions they write.

ALTER TABLE "stores" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stores" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "stores"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint
ALTER TABLE "stock_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "stock_items"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint
ALTER TABLE "reorder_levels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reorder_levels" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "reorder_levels"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

-- A store is renamed or retired, never changes kind. A stock item changes its
-- pack size or is retired; its billable item, drug and base unit are fixed,
-- since its stock is counted in that unit. A reorder level changes its level.
GRANT SELECT, INSERT ON "stores" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("name", "is_active") ON "stores" TO hospital_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "stock_items" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("pack_size", "is_active") ON "stock_items" TO hospital_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "reorder_levels" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("level") ON "reorder_levels" TO hospital_app;
--> statement-breakpoint

INSERT INTO "audit_actions" ("action") VALUES
  ('store.created'),
  ('store.updated'),
  ('stock_item.created'),
  ('stock_item.updated'),
  ('reorder_levels.set');
