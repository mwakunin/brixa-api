-- The controlled-drug register (P4 slice 4, CLAUDE.md rule 12): row-level
-- security, read-only for the app, append-only for every role, written by a
-- trigger on the stock ledger, and its read audit.

ALTER TABLE "controlled_drug_register" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "controlled_drug_register" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "controlled_drug_register"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

-- The app reads the register and never writes it: only the trigger below
-- does, so no request can add, change or leave out a line.
GRANT SELECT ON "controlled_drug_register" TO hospital_app;
--> statement-breakpoint

CREATE FUNCTION controlled_drug_register_append_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'the controlled-drug register is append-only: % refused', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER controlled_drug_register_append_only
  BEFORE UPDATE OR DELETE ON "controlled_drug_register"
  FOR EACH ROW EXECUTE FUNCTION controlled_drug_register_append_only();
--> statement-breakpoint

-- A line for every movement of a scheduled drug, in the movement's own
-- transaction. SECURITY DEFINER, so it writes what the app may only read;
-- it therefore names the facility in every query rather than relying on
-- the request's policies. Lines of one drug in one store are written one at
-- a time, under a transaction lock, so each balance follows the one before:
-- the balance is the last line's plus this movement, never re-summed, as
-- rows of one statement are all visible to each of its triggers.
CREATE FUNCTION controlled_drug_register_write() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  drug text;
  last_balance integer;
  brought integer;
  patient uuid;
  prescriber uuid;
  prescriber_licence text;
  recorder_licence text;
BEGIN
  SELECT si.drug_code INTO drug
  FROM stock_batches b
  JOIN stock_items si ON si.id = b.stock_item_id
  JOIN drug_catalogue dc ON dc.code = si.drug_code
  WHERE b.id = NEW.batch_id AND b.facility_id = NEW.facility_id AND dc.controlled_schedule IS NOT NULL;
  IF drug IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('controlled_register:' || NEW.facility_id || ':' || NEW.store_id || ':' || drug, 0));

  SELECT r.balance INTO last_balance
  FROM controlled_drug_register r
  WHERE r.facility_id = NEW.facility_id AND r.store_id = NEW.store_id AND r.drug_code = drug
  ORDER BY r.entry DESC
  LIMIT 1;

  IF last_balance IS NULL THEN
    -- The drug's first line in this store: what earlier transactions put
    -- here (stock held before the drug was scheduled) is brought forward.
    SELECT coalesce(sum(m.quantity), 0) INTO brought
    FROM stock_movements m
    JOIN stock_batches b ON b.id = m.batch_id
    JOIN stock_items si ON si.id = b.stock_item_id
    WHERE m.facility_id = NEW.facility_id AND m.store_id = NEW.store_id AND si.drug_code = drug
      AND m.recorded_at < NEW.recorded_at;
    IF brought <> 0 THEN
      INSERT INTO controlled_drug_register (facility_id, store_id, drug_code, kind, quantity, balance, recorded_at)
      VALUES (NEW.facility_id, NEW.store_id, drug, 'brought_forward', brought, brought, NEW.recorded_at);
    END IF;
    last_balance := brought;
  END IF;

  -- A dispense, its cancellation or a return names the patient and the
  -- prescriber, with the licence they held then.
  IF NEW.dispense_line_id IS NOT NULL THEN
    SELECT e.patient_id, o.ordered_by, pm.licence_number INTO patient, prescriber, prescriber_licence
    FROM dispense_lines l
    JOIN dispenses d ON d.id = l.dispense_id
    JOIN encounters e ON e.id = d.encounter_id
    JOIN orders o ON o.id = d.order_id
    LEFT JOIN memberships pm ON pm.id = o.ordered_by
    WHERE l.id = NEW.dispense_line_id AND l.facility_id = NEW.facility_id;
  END IF;
  SELECT m.licence_number INTO recorder_licence FROM memberships m WHERE m.id = NEW.recorded_by AND m.facility_id = NEW.facility_id;

  INSERT INTO controlled_drug_register (
    facility_id, store_id, drug_code, movement_id, batch_id, kind, quantity, balance,
    patient_id, prescribed_by, prescriber_licence, recorded_by, recorder_licence, recorded_at
  ) VALUES (
    NEW.facility_id, NEW.store_id, drug, NEW.id, NEW.batch_id, NEW.kind, NEW.quantity, last_balance + NEW.quantity,
    patient, prescriber, prescriber_licence, NEW.recorded_by, recorder_licence, NEW.recorded_at
  );
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER controlled_drug_register_write
  AFTER INSERT ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION controlled_drug_register_write();
--> statement-breakpoint

INSERT INTO "audit_actions" ("action") VALUES
  ('controlled_register.viewed');
