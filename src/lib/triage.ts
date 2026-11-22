import { eq } from "drizzle-orm";

import type { AppDb } from "@/db";

import { encounters, queueEntries } from "@/db/schema";

import type { AllergyCategory, Severity } from "./allergies";
import type { Reading } from "./observations";
import type { PatientActor } from "./patients";
import type { Priority } from "./queues";

import { recordAllergy, recordNoKnownAllergies } from "./allergies";
import { recordComplaint } from "./consultation";
import { recordVitals } from "./observations";
import { finish, QueueError } from "./queues";
import { closedVisit } from "./visit-closed";

/**
 * Triage in one step (after the design review of 2026-11-21): today's
 * complaint, the vital signs, the allergies asked about, how soon the patient
 * must be seen and which clinic next, recorded together as the nurse presses
 * one button. Each part goes through the same code as its own route.
 *
 * It runs in the request's one transaction, which rolls back on any refusal:
 * so either all of it is recorded or none of it, and the screen can say "Not
 * saved" and mean it. With an Idempotency-Key, a press sent again after a
 * dropped connection records it once.
 */

export type TriageAllergy
  = | { noKnownAllergies: true }
    | { category: AllergyCategory; allergen: string; drugCode?: string; reaction?: string; severity?: Severity };

export interface TriageInput {
  complaint?: string;
  readings?: Reading[];
  allergies?: TriageAllergy[];
  priority: Priority;
  nextServicePointId?: string;
}

export async function triage(tx: AppDb, facilityId: string, entryId: string, input: TriageInput, actor: PatientActor, at = new Date()): ReturnType<typeof finish> {
  const [entry] = await tx
    .select({ encounterId: queueEntries.encounterId, patientId: encounters.patientId, visitStatus: encounters.status })
    .from(queueEntries)
    .innerJoin(encounters, eq(encounters.id, queueEntries.encounterId))
    .where(eq(queueEntries.id, entryId))
    .limit(1);
  if (!entry)
    throw new QueueError("entry_not_found");
  // A closed visit first: its queue entry ended with it, and the reason is the visit's.
  if (entry.visitStatus !== "open")
    throw await closedVisit(tx, entry.encounterId, new QueueError("not_open"));

  if (input.complaint !== undefined)
    await recordComplaint(tx, facilityId, entry.encounterId, input.complaint, actor, at);
  if (input.readings && input.readings.length > 0)
    await recordVitals(tx, facilityId, entry.encounterId, { readings: input.readings }, actor, at);
  for (const allergy of input.allergies ?? []) {
    if ("noKnownAllergies" in allergy)
      await recordNoKnownAllergies(tx, facilityId, entry.patientId, actor, at);
    else
      await recordAllergy(tx, facilityId, entry.patientId, allergy, actor, at);
  }
  return finish(tx, facilityId, entryId, { priority: input.priority, nextServicePointId: input.nextServicePointId }, actor, at);
}
