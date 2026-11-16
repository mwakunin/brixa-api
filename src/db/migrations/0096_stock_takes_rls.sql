-- Stock takes (P4 slice 5): row-level security, privileges, the STK series,
-- the lifecycle held for every role, and the audit actions.

ALTER TABLE "stock_takes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_takes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "stock_takes"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint
ALTER TABLE "stock_take_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_take_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "stock_take_lines"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

-- A count changes only its lifecycle; a line only its count, and what was
-- expected once it is submitted.
GRANT SELECT, INSERT ON "stock_takes", "stock_take_lines" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("status", "submitted_by", "submitted_at", "adjustment_id", "cancelled_by", "cancelled_at", "cancellation_reason") ON "stock_takes" TO hospital_app;
--> statement-breakpoint
GRANT UPDATE ("counted_quantity", "counted_at", "counted_by", "expected_quantity") ON "stock_take_lines" TO hospital_app;
--> statement-breakpoint

-- Submitted or cancelled is final; a line changes only while its count is open.
CREATE FUNCTION stock_takes_final() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'counting' THEN
    RAISE EXCEPTION 'a stock take submitted or cancelled cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stock_takes_final
  BEFORE UPDATE OR DELETE ON "stock_takes"
  FOR EACH ROW EXECUTE FUNCTION stock_takes_final();
--> statement-breakpoint
CREATE FUNCTION stock_take_lines_while_counting() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NOT EXISTS (SELECT 1 FROM "stock_takes" s WHERE s."id" = NEW."stock_take_id" AND s."status" = 'counting') THEN
    RAISE EXCEPTION 'a stock take''s lines change only while it is counted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stock_take_lines_while_counting
  BEFORE INSERT OR UPDATE OR DELETE ON "stock_take_lines"
  FOR EACH ROW EXECUTE FUNCTION stock_take_lines_while_counting();
--> statement-breakpoint

-- The stock-take series for facilities onboarded before it existed (STK-2026-000001).
INSERT INTO "number_series" ("facility_id", "kind", "prefix", "padding", "reset_period")
SELECT f."id", 'stock_take', 'STK-', 6, 'yearly'
FROM "facilities" f
ON CONFLICT ("facility_id", "kind") DO NOTHING;
--> statement-breakpoint

INSERT INTO "audit_actions" ("action") VALUES
  ('stock_take.opened'),
  ('stock_take.counted'),
  ('stock_take.submitted'),
  ('stock_take.cancelled');
