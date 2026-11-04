-- Charges and job failures: row-level security, privileges, and the rule
-- that a charge, once captured, changes only by being cancelled.

ALTER TABLE "charges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "charges" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "charges"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

ALTER TABLE "job_failures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "job_failures" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "job_failures"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

GRANT SELECT, INSERT ON "charges" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("cancelled_at", "cancelled_by", "cancellation_reason") ON "charges" TO hospital_app;
--> statement-breakpoint

-- A job records what it could not do; resolving one is an operator's act.
GRANT SELECT, INSERT ON "job_failures" TO hospital_app;
--> statement-breakpoint

-- A ward's bed-day item is set, and changed, by the facility admin.
GRANT UPDATE ("bed_day_item_id") ON "wards" TO hospital_app;
--> statement-breakpoint

-- For every role, the owner included: a captured charge changes only by
-- being cancelled, once (SCHEMA.md §10, "reversal only"). A mistaken charge
-- is cancelled and, if needed, captured again correctly.
CREATE FUNCTION charges_cancel_only() RETURNS trigger
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
    OR NEW.service_date IS DISTINCT FROM OLD.service_date
    OR NEW.bed_stay_id IS DISTINCT FROM OLD.bed_stay_id
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
CREATE TRIGGER charges_cancel_only
  BEFORE UPDATE ON "charges"
  FOR EACH ROW EXECUTE FUNCTION charges_cancel_only();
