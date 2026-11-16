-- Transfers between stores (P4 slice 2): row-level security, privileges,
-- the TRF series, and the audit actions they write.

ALTER TABLE "stock_transfers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_transfers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "stock_transfers"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint
ALTER TABLE "stock_transfer_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_transfer_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "stock_transfer_items"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint
ALTER TABLE "stock_transfer_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_transfer_batches" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "stock_transfer_batches"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

-- A transfer changes only its lifecycle: its stores, number and requester
-- are fixed. What was asked for is written once; a batch it carries changes
-- only by being received.
GRANT SELECT, INSERT ON "stock_transfers", "stock_transfer_items", "stock_transfer_batches" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("status", "sent_by", "sent_at", "received_by", "received_at", "shortfall_reason",
  "shortfall_accepted_by", "shortfall_accepted_at", "closed_by", "closed_at", "close_reason") ON "stock_transfers" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("quantity_received") ON "stock_transfer_batches" TO hospital_app;
--> statement-breakpoint

-- The transfer series for facilities onboarded before it existed, as
-- onboarding now registers it: yearly, six digits (TRF-2026-000001).
INSERT INTO "number_series" ("facility_id", "kind", "prefix", "padding", "reset_period")
SELECT f."id", 'stock_transfer', 'TRF-', 6, 'yearly'
FROM "facilities" f
ON CONFLICT ("facility_id", "kind") DO NOTHING;
--> statement-breakpoint

INSERT INTO "audit_actions" ("action") VALUES
  ('stock_transfer.requested'),
  ('stock_transfer.sent'),
  ('stock_transfer.received'),
  ('stock_transfer.shortfall_accepted'),
  ('stock_transfer.cancelled'),
  ('stock_transfer.declined');
