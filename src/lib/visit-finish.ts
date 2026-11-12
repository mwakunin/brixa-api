import { eq, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { encounters } from "@/db/schema";

import { recordAudit } from "./audit";
import { withMoneyDue } from "./cashier";

/**
 * A visit closing itself once nothing is pending (ROADMAP.md P3, decided
 * 2026-11-10 and 2026-11-11). An open outpatient visit is finished when:
 *
 *   - its patient is in no queue;
 *   - every lab test is resulted (released or verified) or cancelled, and
 *     every service done or cancelled. A medicine is not waited for: it is
 *     dispensed in P4, and a patient may take the paper elsewhere;
 *   - no money is due from the patient, as the cashier's list counts it;
 *   - the patient was seen (a queue turn finished) or tested (an order item
 *     done), so a visit opened a moment ago is not closed before anything
 *     happens in it.
 *
 * A check every 15 minutes (`POST /internal/jobs/finish-visits`) closes the
 * finished ones; the nightly close still takes whatever is left at the end
 * of the day.
 */

/** Of the open outpatient visits (or those named), the ones finished but for money. */
async function settledOtherwise(tx: AppDb, encounterIds?: string[]): Promise<string[]> {
  const named = encounterIds
    ? sql`AND e.id IN (${sql.join(encounterIds.map(id => sql`${id}::uuid`), sql`, `)})`
    : sql``;
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT e.id FROM ${encounters} e
    WHERE e.status = 'open' AND e.kind = 'opd' ${named}
      AND NOT EXISTS (SELECT 1 FROM queue_entries q WHERE q.encounter_id = e.id AND q.status IN ('waiting', 'serving'))
      AND NOT EXISTS (
        SELECT 1 FROM order_items i JOIN orders o ON o.id = i.order_id
        WHERE o.encounter_id = e.id AND i.status <> 'cancelled' AND i.drug_code IS NULL
          AND (i.status = 'ordered'
            OR (i.lab_test_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM lab_results r WHERE r.order_item_id = i.id AND r.status IN ('released', 'verified'))))
      )
      AND (
        EXISTS (SELECT 1 FROM queue_entries q WHERE q.encounter_id = e.id AND q.status = 'done')
        OR EXISTS (SELECT 1 FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.encounter_id = e.id AND i.status = 'done')
      )
    ORDER BY e.started_at, e.id
    LIMIT 500
  `);
  return rows.map(r => r.id);
}

/** The open outpatient visits with nothing pending, oldest first; at most 500 a run. */
export async function finishedVisits(tx: AppDb): Promise<string[]> {
  const candidates = await settledOtherwise(tx);
  const owing = await withMoneyDue(tx, candidates);
  return candidates.filter(id => !owing.has(id));
}

/**
 * Closes a visit if it is still finished once locked, with nobody as its
 * closer; returns whether it did. Its patient is in no queue, so nothing
 * else needs ending.
 */
export async function closeFinishedVisit(tx: AppDb, facilityId: string, id: string): Promise<boolean> {
  await tx.select({ id: encounters.id }).from(encounters).where(eq(encounters.id, id)).for("update");
  const [finished] = await settledOtherwise(tx, [id]);
  if (!finished || (await withMoneyDue(tx, [id])).has(id))
    return false;

  const at = new Date();
  await tx.update(encounters).set({ status: "closed", endedAt: at, closedBy: null }).where(eq(encounters.id, id));
  await recordAudit(tx, {
    facilityId,
    actorId: null,
    action: "encounter.closed",
    entityType: "encounter",
    entityId: id,
    summary: "Closed by itself: nothing was left pending",
    detail: { by: "visit_finish" },
  });
  return true;
}
