-- Hash rather than btree: a btree entry is limited to about a third of a page,
-- so a callback carrying an oversized CheckoutRequestID made the insert fail,
-- and the fallback that keeps an unrecordable callback failed the same way.
-- Both lookups are equality only, which a hash index serves at any length.
DROP INDEX "gateway_exchanges_stk_checkout_index";--> statement-breakpoint
DROP INDEX "mpesa_transactions_stk_checkout_index";--> statement-breakpoint
CREATE INDEX "gateway_exchanges_stk_checkout_index" ON "gateway_exchanges" USING hash (("response" #>> '{Body,stkCallback,CheckoutRequestID}')) WHERE "gateway_exchanges"."operation" = 'stk_callback';--> statement-breakpoint
CREATE INDEX "mpesa_transactions_stk_checkout_index" ON "mpesa_transactions" USING hash (("raw_payload" #>> '{Body,stkCallback,CheckoutRequestID}')) WHERE "mpesa_transactions"."source" = 'stk';