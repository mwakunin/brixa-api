-- Dispensing (P4 slice 3a): row-level security, privileges, a charge's
-- dispense line frozen with the rest of it, and the audit actions.

ALTER TABLE "dispenses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dispenses" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "dispenses"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint
ALTER TABLE "dispense_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dispense_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "dispense_lines"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint
ALTER TABLE "medicines_not_supplied" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "medicines_not_supplied" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "medicines_not_supplied"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

-- A dispense changes only its lifecycle; its lines and a medicine not
-- supplied are written once.
GRANT SELECT, INSERT ON "dispenses", "dispense_lines", "medicines_not_supplied" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("status", "handed_over_by", "handed_over_at", "cancelled_by", "cancelled_at", "cancellation_reason") ON "dispenses" TO hospital_app;
--> statement-breakpoint

-- As in 0071, with the dispense line a charge was raised for frozen too.
CREATE OR REPLACE FUNCTION charges_cancel_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'a cancelled charge cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.facility_id IS DISTINCT FROM OLD.facility_id
    OR NEW.encounter_id IS DISTINCT FROM OLD.encounter_id
    OR NEW.billable_item_id IS DISTINCT FROM OLD.billable_item_id
    OR NEW.quantity IS DISTINCT FROM OLD.quantity
    OR NEW.unit_price_cents IS DISTINCT FROM OLD.unit_price_cents
    OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
    OR NEW.price_list_item_id IS DISTINCT FROM OLD.price_list_item_id
    OR NEW.printed_name IS DISTINCT FROM OLD.printed_name
    OR NEW.service_date IS DISTINCT FROM OLD.service_date
    OR NEW.bed_stay_id IS DISTINCT FROM OLD.bed_stay_id
    OR NEW.queue_entry_id IS DISTINCT FROM OLD.queue_entry_id
    OR NEW.order_item_id IS DISTINCT FROM OLD.order_item_id
    OR NEW.dispense_line_id IS DISTINCT FROM OLD.dispense_line_id
    OR NEW.manual_reason IS DISTINCT FROM OLD.manual_reason
    OR NEW.captured_by IS DISTINCT FROM OLD.captured_by
    OR NEW.captured_at IS DISTINCT FROM OLD.captured_at
  THEN
    RAISE EXCEPTION 'a charge is cancelled, never edited'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

INSERT INTO "audit_actions" ("action") VALUES
  ('dispense.prepared'),
  ('dispense.handed_over'),
  ('dispense.cancelled'),
  ('medicine.not_supplied'),
  ('pharmacy.worklist_viewed');
