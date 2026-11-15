-- Goods received, batches and the stock ledger (P4 slice 1b): row-level
-- security, privileges, the ledger held append-only and never negative, the
-- GRN series, and the audit actions they write.

ALTER TABLE "goods_received" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "goods_received" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "goods_received"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint
ALTER TABLE "stock_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_batches" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "stock_batches"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint
ALTER TABLE "stock_movements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_movements" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "stock_movements"
  FOR ALL
  USING ("facility_id" = app_current_facility())
  WITH CHECK ("facility_id" = app_current_facility());
--> statement-breakpoint

-- A note and its batches are written once: a mistyped line is reversed by a
-- movement and entered again, never edited. The ledger is append-only.
GRANT SELECT, INSERT ON "goods_received", "stock_batches", "stock_movements" TO hospital_app;
--> statement-breakpoint

-- The privileges hold the app; the trigger holds every role, the owner
-- included, as for audit_log (0001). TRUNCATE (the test harness) fires no row
-- trigger.
CREATE FUNCTION stock_movements_append_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'stock_movements is append-only: % refused', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stock_movements_append_only
  BEFORE UPDATE OR DELETE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION stock_movements_append_only();
--> statement-breakpoint

-- On hand per store and batch is the sum of its movements and is never below
-- zero (SCHEMA.md §8). The services check it under the batch's lock, so two
-- takings queue rather than both passing; this holds it for whatever else
-- writes a row. After the statement's rows are in, so a statement that
-- moves stock out and back in is judged on where it ends.
CREATE FUNCTION stock_movements_never_negative() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (SELECT sum("quantity") FROM "stock_movements"
      WHERE "facility_id" = NEW."facility_id" AND "store_id" = NEW."store_id" AND "batch_id" = NEW."batch_id") < 0 THEN
    RAISE EXCEPTION 'batch % would fall below zero in store %', NEW."batch_id", NEW."store_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_movements_never_negative';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stock_movements_never_negative
  AFTER INSERT ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION stock_movements_never_negative();
--> statement-breakpoint

-- The goods-received series for facilities onboarded before it existed, as
-- onboarding now registers it: yearly, six digits (GRN-2026-000001).
INSERT INTO "number_series" ("facility_id", "kind", "prefix", "padding", "reset_period")
SELECT f."id", 'goods_received', 'GRN-', 6, 'yearly'
FROM "facilities" f
ON CONFLICT ("facility_id", "kind") DO NOTHING;
--> statement-breakpoint

INSERT INTO "audit_actions" ("action") VALUES
  ('goods.received'),
  ('stock_batch.reversed');
