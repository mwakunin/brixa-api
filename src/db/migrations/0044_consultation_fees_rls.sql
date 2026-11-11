-- Consultation fees: the admin names a clinic's fee item, and a charge's
-- queue entry, its new source, is frozen like every other column.

GRANT UPDATE ("consultation_item_id") ON "service_points" TO hospital_app;
--> statement-breakpoint

-- As in 0014, with `queue_entry_id` frozen too: a charge is cancelled,
-- never edited, whatever its source.
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
