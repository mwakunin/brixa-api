-- A counted line carries what the ledger held as it was counted (CodeRabbit
-- on #22): a count with no expected quantity beside it would be submitted as
-- a difference of the whole count. No counted line lacks one: the only code
-- that wrote them so was never released.
ALTER TABLE "stock_take_lines" DROP CONSTRAINT "stock_take_lines_counted";--> statement-breakpoint
ALTER TABLE "stock_take_lines" ADD CONSTRAINT "stock_take_lines_counted" CHECK (("stock_take_lines"."counted_quantity" IS NULL) = ("stock_take_lines"."counted_at" IS NULL) AND ("stock_take_lines"."counted_at" IS NULL) = ("stock_take_lines"."counted_by" IS NULL) AND ("stock_take_lines"."counted_quantity" IS NULL OR ("stock_take_lines"."counted_quantity" >= 0 AND "stock_take_lines"."expected_quantity" IS NOT NULL)));
