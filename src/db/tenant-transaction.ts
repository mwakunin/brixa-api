import { sql } from "drizzle-orm";

import type { AppDb } from ".";

import { appDb } from ".";

/**
 * Runs `fn` in a transaction on the app connection with the facility set:
 * the only way a tenant transaction is opened (CLAUDE.md §4, layer 2).
 *
 * `withFacility` uses it for every tenant request; the invitation-accept route
 * and the outbox worker use it for work that belongs to one facility but
 * arrives without a request naming it.
 *
 * `set_config(..., true)` scopes the setting to the transaction, so it is
 * discarded at COMMIT or ROLLBACK and cannot reach the next borrower of the
 * pooled connection. The value is a bind parameter, never interpolated.
 */
export function runAsFacility<T>(facilityId: string, fn: (tx: AppDb) => Promise<T>): Promise<T> {
  return appDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.facility_id', ${facilityId}, true)`);
    return fn(tx);
  });
}
