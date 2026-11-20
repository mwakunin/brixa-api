-- Whether a payment notice came to a replaced callback token (decided
-- 2026-11-20): set as it is kept, and frozen with the rest of the record by
-- mpesa_transactions_immutable (0029). Such a notice is placed by a person
-- only, never matched or settled against a prompt by itself
-- (lib/mpesa-callbacks.ts, lib/mpesa-stk.ts).
ALTER TABLE "mpesa_transactions" ADD COLUMN "came_on_replaced_token" boolean DEFAULT false NOT NULL;
