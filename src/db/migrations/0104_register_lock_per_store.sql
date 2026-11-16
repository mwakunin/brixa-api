-- One register lock per store, not per page (CodeRabbit on #22). A page's
-- lock was taken as each of its movements was written, in the order a
-- request happened to name its drugs: a transfer of morphine then pethidine
-- beside a delivery of pethidine then morphine, in one store, each held the
-- page the other wanted, and Postgres ended one of them as a deadlock. A
-- transaction writes movements in one store only, so with the store's whole
-- register behind one lock there is no second lock to take out of order: the
-- later movement waits for the earlier to commit. The function is otherwise
-- as in 0094.

CREATE OR REPLACE FUNCTION controlled_drug_register_write() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  drug text;
  schedule text;
  last_balance integer;
  patient uuid;
  prescriber uuid;
  prescriber_licence text;
  recorder_licence text;
BEGIN
  SELECT si.drug_code, dc.controlled_schedule INTO drug, schedule
  FROM stock_batches b
  JOIN stock_items si ON si.id = b.stock_item_id
  JOIN drug_catalogue dc ON dc.code = si.drug_code
  WHERE b.id = NEW.batch_id AND b.facility_id = NEW.facility_id;
  IF drug IS NULL THEN
    RETURN NULL;
  END IF;
  IF schedule IS NULL AND NOT EXISTS (
    SELECT 1 FROM controlled_drug_register r
    WHERE r.facility_id = NEW.facility_id AND r.store_id = NEW.store_id AND r.drug_code = drug
  ) THEN
    RETURN NULL;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('controlled_register:' || NEW.facility_id || ':' || NEW.store_id, 0));

  SELECT r.balance INTO last_balance
  FROM controlled_drug_register r
  WHERE r.facility_id = NEW.facility_id AND r.store_id = NEW.store_id AND r.drug_code = drug
  ORDER BY r.entry DESC
  LIMIT 1;

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
    NEW.facility_id, NEW.store_id, drug, NEW.id, NEW.batch_id, NEW.kind, NEW.quantity, coalesce(last_balance, 0) + NEW.quantity,
    patient, prescriber, prescriber_licence, NEW.recorded_by, recorder_licence, clock_timestamp()
  );
  RETURN NULL;
END;
$$;
