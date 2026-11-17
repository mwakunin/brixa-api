import { desc, eq } from "drizzle-orm";

import type { AppDb } from "@/db";

import { encounters, queueEntries } from "@/db/schema";

import type { PatientActor } from "./patients";

import { labTestsWaiting } from "./lab-pending";
import { joinLocked, liveEntryOf, QueueError } from "./queues";

/**
 * A patient back at the clinic with their results (decided 2026-11-17,
 * ROADMAP.md P3). Nobody in the lab may put a patient in a clinic's queue,
 * and a visit with nothing pending closes itself, so without this a patient
 * who had paid could have their visit closed before the doctor saw the
 * result.
 *
 * Called as a result is released or verified, or a lab test cancelled, with
 * the visit locked. When no lab test on the visit still waits, the patient is
 * in no queue, and the last thing that happened in the queues was a clinic
 * finishing with them and asking them to come back, they rejoin that
 * clinic's queue. No second fee: a clinic charges once per visit. Whoever
 * released, verified or cancelled the last of them is recorded as sending
 * them back.
 *
 * A clinic that cannot take them now (out of use, or its fee unpriced)
 * leaves them where they are, in a savepoint so nothing half-done stays:
 * the result is on the clinician's results-to-review list either way.
 */
export async function returnWithResults(tx: AppDb, facilityId: string, encounterId: string, actor: PatientActor, at: Date): Promise<void> {
  const [visit] = await tx.select({ id: encounters.id, kind: encounters.kind, status: encounters.status }).from(encounters).where(eq(encounters.id, encounterId)).limit(1);
  if (!visit || visit.status !== "open" || visit.kind === "ipd")
    return;
  if (await labTestsWaiting(tx, encounterId) || await liveEntryOf(tx, encounterId))
    return;
  const [last] = await tx
    .select({ servicePointId: queueEntries.servicePointId, status: queueEntries.status, comeBack: queueEntries.comeBackWithResults })
    .from(queueEntries)
    .where(eq(queueEntries.encounterId, encounterId))
    .orderBy(desc(queueEntries.joinedAt), desc(queueEntries.id))
    .limit(1);
  if (!last || last.status !== "done" || !last.comeBack)
    return;

  try {
    await tx.transaction(sp => joinLocked(sp, facilityId, visit, last.servicePointId, actor, at, { returnedWithResults: true }));
  }
  catch (err) {
    if (err instanceof QueueError)
      return;
    throw err;
  }
}
