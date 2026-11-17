import { sql } from "drizzle-orm";

import type { AppDb } from "@/db";

/**
 * Whether a lab test on the visit still waits for its result: ordered and
 * not cancelled, with no result released or verified. A test whose specimen
 * was rejected, to be taken again, still waits; a corrected result waits
 * again until its new version is released or verified.
 */
export async function labTestsWaiting(tx: AppDb, encounterId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ waiting: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE o.encounter_id = ${encounterId} AND i.lab_test_id IS NOT NULL AND i.status <> 'cancelled'
        AND NOT EXISTS (SELECT 1 FROM lab_results r WHERE r.order_item_id = i.id AND r.status IN ('released', 'verified'))
    ) AS waiting`);
  return rows[0].waiting;
}
