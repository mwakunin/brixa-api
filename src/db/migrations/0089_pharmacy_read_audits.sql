-- Reads of a single dispense and of the returns list name patients' visits
-- and medicines, so they are audited (rule 9; CodeRabbit on #20).
INSERT INTO "audit_actions" ("action") VALUES
  ('dispense.viewed'),
  ('dispense_return.listed');
