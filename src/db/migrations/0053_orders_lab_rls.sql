-- Orders and the lab catalogue: row-level security, privileges, the
-- reference ranges' no-overlap rule, and the lifecycles held for every role.

ALTER TABLE "lab_tests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "lab_tests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "lab_tests"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint
ALTER TABLE "lab_analytes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "lab_analytes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "lab_analytes"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint
ALTER TABLE "lab_reference_ranges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "lab_reference_ranges" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "lab_reference_ranges"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "orders" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "orders"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint
ALTER TABLE "order_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "order_items"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

-- The catalogue: a test changes its specimen or is retired; an analyte its
-- wording, unit, answers and critical limits, never its kind; a range is
-- only ever retired, when a new set replaces it.
GRANT SELECT, INSERT ON "lab_tests" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("specimen_type", "is_active") ON "lab_tests" TO hospital_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "lab_analytes" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("name", "unit", "choices", "abnormal_choices", "critical_low", "critical_high", "is_active") ON "lab_analytes" TO hospital_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "lab_reference_ranges" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("retired_at") ON "lab_reference_ranges" TO hospital_app;
--> statement-breakpoint

-- An order is written once; its items carry the lifecycle.
GRANT SELECT, INSERT ON "orders" TO hospital_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "order_items" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("status", "done_at", "done_by", "cancelled_at", "cancelled_by", "cancellation_reason") ON "order_items" TO hospital_app;
--> statement-breakpoint

-- One current range per analyte for any patient: no two overlap in sex
-- (`any` overlaps both) and age. Retired ranges are history and may.
ALTER TABLE "lab_reference_ranges"
  ADD CONSTRAINT "lab_reference_ranges_no_overlap" EXCLUDE USING gist (
    "analyte_id" WITH =,
    (CASE "sex" WHEN 'male' THEN int4range(1, 2) WHEN 'female' THEN int4range(2, 3) ELSE int4range(1, 3) END) WITH &&,
    int4range("age_from_days", "age_to_days") WITH &&
  ) WHERE ("retired_at" IS NULL);
--> statement-breakpoint

-- For every role, the owner included: a range is retired once and otherwise
-- never changes; nothing is deleted.
CREATE FUNCTION lab_reference_ranges_retire_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a reference range is retired, never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.retired_at IS NOT NULL
    OR NEW.retired_at IS NULL
    OR (to_jsonb(NEW) - 'retired_at') IS DISTINCT FROM (to_jsonb(OLD) - 'retired_at') THEN
    RAISE EXCEPTION 'a reference range is only retired, once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER lab_reference_ranges_retire_only
  BEFORE UPDATE OR DELETE ON "lab_reference_ranges"
  FOR EACH ROW EXECUTE FUNCTION lab_reference_ranges_retire_only();
--> statement-breakpoint

-- For every role: an order, once written, never changes and is never deleted.
CREATE FUNCTION orders_written_once() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'an order is written once; its items are done or cancelled'
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER orders_written_once
  BEFORE UPDATE OR DELETE ON "orders"
  FOR EACH ROW EXECUTE FUNCTION orders_written_once();
--> statement-breakpoint

-- For every role: an item is written ordered; what it asks for never
-- changes; it is done or cancelled once, and then never changes; nothing is
-- deleted.
CREATE FUNCTION order_items_lifecycle() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an order item is cancelled, never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'ordered' THEN
      RAISE EXCEPTION 'an order item is written ordered'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'ordered' THEN
    RAISE EXCEPTION 'a done or cancelled order item cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.facility_id IS DISTINCT FROM OLD.facility_id
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.lab_test_id IS DISTINCT FROM OLD.lab_test_id
    OR NEW.billable_item_id IS DISTINCT FROM OLD.billable_item_id
  THEN
    RAISE EXCEPTION 'what an order item asks for never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER order_items_lifecycle
  BEFORE INSERT OR UPDATE OR DELETE ON "order_items"
  FOR EACH ROW EXECUTE FUNCTION order_items_lifecycle();
--> statement-breakpoint

-- As in 0044, with `order_item_id` frozen too: a charge is cancelled, never
-- edited, whatever its source.
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
    OR NEW.service_date IS DISTINCT FROM OLD.service_date
    OR NEW.bed_stay_id IS DISTINCT FROM OLD.bed_stay_id
    OR NEW.queue_entry_id IS DISTINCT FROM OLD.queue_entry_id
    OR NEW.order_item_id IS DISTINCT FROM OLD.order_item_id
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
