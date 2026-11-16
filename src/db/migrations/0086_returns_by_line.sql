-- A patient's return moves stock against its dispense line, as dispensing
-- and cancelling do, rather than against the return (P4 slice 3b): the
-- returns table sits with the invoice adjustments it may ask for, after the
-- ledger, and the ledger keeps one source per kind of thing that moved it.
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_shape";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_dispense_return_fk";
--> statement-breakpoint
DROP INDEX "stock_movements_dispense_return_index";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP COLUMN "dispense_return_id";--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_shape" CHECK (num_nonnulls("stock_movements"."goods_received_id", "stock_movements"."transfer_id", "stock_movements"."dispense_line_id", "stock_movements"."stock_adjustment_line_id") = 1
      AND (("stock_movements"."kind" = 'receipt' AND "stock_movements"."quantity" > 0 AND "stock_movements"."goods_received_id" IS NOT NULL AND "stock_movements"."reason" IS NULL)
        OR ("stock_movements"."kind" = 'receipt_reversed' AND "stock_movements"."quantity" < 0 AND "stock_movements"."goods_received_id" IS NOT NULL
            AND "stock_movements"."reason" IS NOT NULL AND length(btrim("stock_movements"."reason")) > 0)
        OR ("stock_movements"."kind" = 'transfer_out' AND "stock_movements"."quantity" < 0 AND "stock_movements"."transfer_id" IS NOT NULL AND "stock_movements"."reason" IS NULL)
        OR ("stock_movements"."kind" = 'transfer_in' AND "stock_movements"."quantity" > 0 AND "stock_movements"."transfer_id" IS NOT NULL AND "stock_movements"."reason" IS NULL)
        OR ("stock_movements"."kind" = 'dispense' AND "stock_movements"."quantity" < 0 AND "stock_movements"."dispense_line_id" IS NOT NULL AND "stock_movements"."reason" IS NULL)
        OR ("stock_movements"."kind" = 'dispense_cancelled' AND "stock_movements"."quantity" > 0 AND "stock_movements"."dispense_line_id" IS NOT NULL AND "stock_movements"."reason" IS NULL)
        OR ("stock_movements"."kind" = 'dispense_returned' AND "stock_movements"."quantity" > 0 AND "stock_movements"."dispense_line_id" IS NOT NULL AND "stock_movements"."reason" IS NULL)
        OR ("stock_movements"."kind" = 'adjustment' AND "stock_movements"."quantity" <> 0 AND "stock_movements"."stock_adjustment_line_id" IS NOT NULL AND "stock_movements"."reason" IS NULL)));