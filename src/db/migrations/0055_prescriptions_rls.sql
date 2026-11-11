-- Prescriptions: the shared drug catalogue, the RX series, and medicines
-- frozen with the rest of an order item.

-- drug_catalogue is shared reference data (CLAUDE.md rule 1), like
-- icd_codes: no facility_id and no row-level security. The app role only
-- reads it; `pnpm drugs:load` writes it as the owner.
GRANT SELECT ON "drug_catalogue" TO hospital_app;
--> statement-breakpoint

-- The prescription series for facilities onboarded before it existed, as
-- onboarding now registers it: yearly, six digits (RX-2026-000001).
INSERT INTO "number_series" ("facility_id", "kind", "prefix", "padding", "reset_period")
SELECT f."id", 'prescription', 'RX-', 6, 'yearly'
FROM "facilities" f
ON CONFLICT ("facility_id", "kind") DO NOTHING;
--> statement-breakpoint

-- As in 0053, but comparing everything except the lifecycle columns, so a
-- medicine's dose, route and quantity are frozen with what the item asks for,
-- and so will any column added later.
CREATE OR REPLACE FUNCTION order_items_lifecycle() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  lifecycle constant text[] := ARRAY['status', 'done_at', 'done_by', 'cancelled_at', 'cancelled_by', 'cancellation_reason'];
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
  IF (to_jsonb(NEW) - lifecycle) IS DISTINCT FROM (to_jsonb(OLD) - lifecycle) THEN
    RAISE EXCEPTION 'what an order item asks for never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- As in 0046, with the catalogue drug an allergy names frozen too.
CREATE OR REPLACE FUNCTION patient_allergies_end_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an allergy is ended, never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'an ended allergy cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.facility_id IS DISTINCT FROM OLD.facility_id
    OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
    OR NEW.category IS DISTINCT FROM OLD.category
    OR NEW.allergen IS DISTINCT FROM OLD.allergen
    OR NEW.drug_code IS DISTINCT FROM OLD.drug_code
    OR NEW.reaction IS DISTINCT FROM OLD.reaction
    OR NEW.severity IS DISTINCT FROM OLD.severity
    OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
    OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
  THEN
    RAISE EXCEPTION 'an allergy is ended, never edited'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
