import { and, desc, eq, isNull } from "drizzle-orm";

import type { AppDb } from "@/db";

import { encounters, memberships, observations, user } from "@/db/schema";

import type { PatientActor } from "./patients";
import type { VitalSign } from "./vital-signs";

import { recordAudit } from "./audit";
import { VITAL_SIGNS } from "./vital-signs";

/**
 * Vital signs (SCHEMA.md §8, P3 slice 2): taken at triage, in a clinic or on
 * a ward, against an open encounter, by a licensed clinician (rule 25). A
 * set taken together shares its time. A wrong value is marked entered in
 * error with a reason; nothing is edited or removed.
 */

type ObservationRow = typeof observations.$inferSelect;
type CodeColumn = ObservationRow["code"];
// A compile error here names a vital sign the column and VITAL_SIGNS disagree on.
const _sameCodes: [VitalSign, CodeColumn] extends [CodeColumn, VitalSign] ? true : never = true;
void _sameCodes;

export type ObservationErrorCode
  = | "encounter_not_found"
    | "not_open"
    | "implausible"
    | "blood_pressure_pair"
    | "observed_out_of_range"
    | "not_found"
    | "already_in_error";

export class ObservationError extends Error {
  constructor(readonly code: ObservationErrorCode) {
    super({
      encounter_not_found: "No such encounter",
      not_open: "Vital signs are recorded on an open encounter",
      implausible: "A reading is outside what a real one can be; check it was typed right",
      blood_pressure_pair: "Blood pressure needs both the systolic and the diastolic reading",
      observed_out_of_range: "The time taken must fall within the encounter, and not in the future",
      not_found: "No such reading",
      already_in_error: "This reading is already marked entered in error",
    }[code]);
    this.name = "ObservationError";
  }
}

export interface Reading {
  code: VitalSign;
  value: number;
}

/** Whether any reading on the encounter still stands (not marked entered in error). */
export async function hasStandingObservations(tx: AppDb, encounterId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: observations.id })
    .from(observations)
    .where(and(eq(observations.encounterId, encounterId), isNull(observations.enteredInErrorAt)))
    .limit(1);
  return Boolean(row);
}

/** Whether a reading is one a real patient could give: not a judgement of normal. */
export function plausible(reading: Reading): boolean {
  const range = VITAL_SIGNS[reading.code];
  return Number.isFinite(reading.value) && reading.value >= range.min && reading.value <= range.max;
}

/**
 * Records a set of readings taken together. Takes the encounter's share lock,
 * so closing the visit waits for it, and refuses one that is no longer open.
 */
export async function recordVitals(
  tx: AppDb,
  facilityId: string,
  encounterId: string,
  input: { readings: Reading[]; observedAt?: Date },
  actor: PatientActor,
  now = new Date(),
): Promise<ObservationRow[]> {
  const [encounter] = await tx
    .select({ status: encounters.status, startedAt: encounters.startedAt })
    .from(encounters)
    .where(eq(encounters.id, encounterId))
    .for("share")
    .limit(1);
  if (!encounter)
    throw new ObservationError("encounter_not_found");
  if (encounter.status !== "open")
    throw new ObservationError("not_open");

  if (!input.readings.every(plausible))
    throw new ObservationError("implausible");
  const codes = new Set(input.readings.map(r => r.code));
  if (codes.has("bp_systolic") !== codes.has("bp_diastolic"))
    throw new ObservationError("blood_pressure_pair");
  const observedAt = input.observedAt ?? now;
  if (observedAt > now || observedAt < encounter.startedAt)
    throw new ObservationError("observed_out_of_range");

  const rows = await tx.insert(observations).values(input.readings.map(r => ({
    facilityId,
    encounterId,
    code: r.code,
    value: String(r.value),
    observedAt,
    recordedAt: now,
    recordedBy: actor.membershipId,
  }))).returning();

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "observation.recorded",
    entityType: "encounter",
    entityId: encounterId,
    summary: `Recorded ${rows.length} vital sign${rows.length === 1 ? "" : "s"}`,
    detail: { codes: [...codes] },
  });
  return rows;
}

/** A reading as staff see it, labelled and in its unit. */
export interface ShownObservation {
  id: string;
  code: ObservationRow["code"];
  label: string;
  value: number;
  unit: string;
  observedAt: Date;
  recordedBy: { membershipId: string; name: string };
  enteredInError: { at: Date; reason: string } | null;
}

/** An encounter's readings, newest first, those entered in error included and marked. Not audited: for answering a write. */
export async function observationsOf(tx: AppDb, encounterId: string): Promise<ShownObservation[]> {
  const rows = await tx
    .select({ observation: observations, recordedByName: user.name })
    .from(observations)
    .innerJoin(memberships, eq(memberships.id, observations.recordedBy))
    .innerJoin(user, eq(user.id, memberships.userId))
    .where(eq(observations.encounterId, encounterId))
    .orderBy(desc(observations.observedAt), desc(observations.recordedAt));

  return rows.map(({ observation: o, recordedByName }) => ({
    id: o.id,
    code: o.code,
    label: VITAL_SIGNS[o.code].label,
    value: Number(o.value),
    unit: VITAL_SIGNS[o.code].unit,
    observedAt: o.observedAt,
    recordedBy: { membershipId: o.recordedBy, name: recordedByName },
    enteredInError: o.enteredInErrorAt ? { at: o.enteredInErrorAt, reason: o.enteredInErrorReason! } : null,
  }));
}

/** An encounter's readings, as `observationsOf`, with an audit entry: they are part of the record (rule 9). */
export async function listObservations(tx: AppDb, facilityId: string, encounterId: string, actor: PatientActor): Promise<ShownObservation[]> {
  const [encounter] = await tx.select({ id: encounters.id }).from(encounters).where(eq(encounters.id, encounterId)).limit(1);
  if (!encounter)
    throw new ObservationError("encounter_not_found");

  const readings = await observationsOf(tx, encounterId);
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "encounter.viewed",
    entityType: "encounter",
    entityId: encounterId,
    summary: `Viewed vital signs (${readings.length})`,
  });
  return readings;
}

/** Marks a reading entered in error, for a stated reason. The reading stays on the record, marked. */
export async function markEnteredInError(
  tx: AppDb,
  facilityId: string,
  observationId: string,
  reason: string,
  actor: PatientActor,
  now = new Date(),
): Promise<ObservationRow> {
  const [current] = await tx.select().from(observations).where(eq(observations.id, observationId)).for("update").limit(1);
  if (!current)
    throw new ObservationError("not_found");
  if (current.enteredInErrorAt)
    throw new ObservationError("already_in_error");

  const [marked] = await tx.update(observations)
    .set({ enteredInErrorAt: now, enteredInErrorBy: actor.membershipId, enteredInErrorReason: reason })
    .where(eq(observations.id, observationId))
    .returning();

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "observation.entered_in_error",
    entityType: "observation",
    entityId: observationId,
    summary: `Marked a ${VITAL_SIGNS[current.code].label.toLowerCase()} reading entered in error: ${reason}`,
    detail: { encounterId: current.encounterId, code: current.code, value: current.value, reason },
  });
  return marked;
}
