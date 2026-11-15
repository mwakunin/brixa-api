-- Patients' returns and stock adjustments (P4 slice 3b): row-level
-- security, privileges, and the audit actions they write.

ALTER TABLE "dispense_returns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dispense_returns" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "dispense_returns"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint
ALTER TABLE "stock_adjustments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_adjustments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "stock_adjustments"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "stock_adjustment_lines"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

-- A return and an adjustment change only by being decided; an adjustment's
-- lines are written once.
GRANT SELECT, INSERT ON "dispense_returns", "stock_adjustments", "stock_adjustment_lines" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("status", "decided_by", "decided_at", "invoice_adjustment_id") ON "dispense_returns" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("status", "decided_by", "decided_at") ON "stock_adjustments" TO hospital_app;
--> statement-breakpoint

INSERT INTO "audit_actions" ("action") VALUES
  ('dispense.returned'),
  ('dispense_return.approved'),
  ('dispense_return.rejected'),
  ('stock_adjustment.requested'),
  ('stock_adjustment.approved'),
  ('stock_adjustment.rejected'),
  ('stock_adjustment.withdrawn');
