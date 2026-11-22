import { sql } from "drizzle-orm";

import db from "@/db";
import { idempotentRequests } from "@/db/schema";

/**
 * Forgets Idempotency-Keys more than a day old, for every facility, as the
 * nightly close of visits runs (`POST /internal/jobs/close-visits`). A screen
 * retries within minutes; a day is ample. On the owner connection: the
 * runtime role deletes from no tenant table (rule 5), this one included.
 */
export async function forgetOldKeys(): Promise<{ forgotten: number }> {
  const result = await db.execute(sql`DELETE FROM ${idempotentRequests} WHERE ${idempotentRequests.createdAt} < now() - interval '1 day'`);
  return { forgotten: result.rowCount ?? 0 };
}
