import { and, asc, desc, eq, isNull } from "drizzle-orm";

import type { AppDb } from "@/db";

import { admissions, beds, bedStays, encounters, patientNumbers, patients, wards } from "@/db/schema";

import type { PatientActor } from "./patients";

import { recordAudit } from "./audit";
import { accrueBedDays, liveChargeCount } from "./charges";
import { isExclusionViolation, isUniqueViolation } from "./db-errors";
import { issueNumber } from "./number-series";
import { bedOccupied, bedWithWard } from "./wards";

/**
 * Encounters (SCHEMA.md §8): outpatient visits, emergency attendances and
 * admissions. A thin admission for P2: enough to place a patient in a bed,
 * move them, and discharge them, so bed-days can be billed. Nursing, rounds
 * and the discharge summary are P5.
 *
 * Every write takes the encounter's row lock first (lock order M8: the
 * encounter before anything charged against it).
 */

type EncounterRow = typeof encounters.$inferSelect;
export type EncounterKind = EncounterRow["kind"];
export type Disposition = NonNullable<(typeof admissions.$inferSelect)["dischargeDisposition"]>;

export class EncounterError extends Error {
  constructor(readonly code:
    | "patient_not_found"
    | "not_found"
    | "already_open"
    | "already_admitted"
    | "not_open"
    | "use_discharge"
    | "not_admitted"
    | "bed_not_found"
    | "bed_unavailable"
    | "bed_occupied"
    | "same_bed"
    | "parent_mismatch"
    | "has_charges") {
    super({
      patient_not_found: "No such patient",
      not_found: "No such encounter",
      already_open: "This patient already has an open visit of that kind",
      already_admitted: "This patient is already admitted",
      not_open: "This encounter is no longer open",
      use_discharge: "An admission ends by discharge, not by closing it",
      not_admitted: "This encounter is not an admission",
      bed_not_found: "No such bed",
      bed_unavailable: "That bed or its ward is out of use",
      bed_occupied: "That bed is occupied",
      same_bed: "The patient is already in that bed",
      parent_mismatch: "That visit belongs to another patient",
      has_charges: "This encounter has charges; cancel them first",
    }[code]);
    this.name = "EncounterError";
  }
}

async function patientExists(tx: AppDb, patientId: string) {
  const [patient] = await tx.select({ id: patients.id }).from(patients).where(eq(patients.id, patientId)).limit(1);
  if (!patient)
    throw new EncounterError("patient_not_found");
}

/** The encounter, locked for the change about to be made. */
async function lockEncounter(tx: AppDb, id: string): Promise<EncounterRow> {
  const [encounter] = await tx.select().from(encounters).where(eq(encounters.id, id)).for("update").limit(1);
  if (!encounter)
    throw new EncounterError("not_found");
  if (encounter.status !== "open")
    throw new EncounterError("not_open");
  return encounter;
}

/** A bed that exists, is in use, and is free. */
async function freeBed(tx: AppDb, bedId: string) {
  const bed = await bedWithWard(tx, bedId);
  if (!bed)
    throw new EncounterError("bed_not_found");
  if (!bed.isActive || !bed.wardActive)
    throw new EncounterError("bed_unavailable");
  if (await bedOccupied(tx, bedId))
    throw new EncounterError("bed_occupied");
  return bed;
}

/** Inserts a stay; the exclusion constraints are the backstop for a race. */
async function startStay(tx: AppDb, facilityId: string, admissionId: string, bedId: string, at: Date, actor: PatientActor) {
  try {
    await tx.insert(bedStays).values({ facilityId, admissionId, bedId, startedAt: at, startedBy: actor.membershipId });
  }
  catch (err) {
    if (isExclusionViolation(err))
      throw new EncounterError("bed_occupied");
    throw err;
  }
}

async function endOpenStay(tx: AppDb, admissionId: string, at: Date, actor: PatientActor) {
  const [ended] = await tx
    .update(bedStays)
    .set({ endedAt: at, endedBy: actor.membershipId })
    .where(and(eq(bedStays.admissionId, admissionId), isNull(bedStays.endedAt)))
    .returning({ bedId: bedStays.bedId });
  return ended?.bedId ?? null;
}

// ---------------------------------------------------------------------------
// Visits
// ---------------------------------------------------------------------------

/** Opens an outpatient visit or an emergency attendance. */
export async function openEncounter(
  tx: AppDb,
  facilityId: string,
  input: { patientId: string; kind: "opd" | "emergency" },
  actor: PatientActor,
): Promise<EncounterRow> {
  await patientExists(tx, input.patientId);

  let encounter: EncounterRow;
  try {
    [encounter] = await tx.insert(encounters).values({
      facilityId,
      patientId: input.patientId,
      kind: input.kind,
      openedBy: actor.membershipId,
    }).returning();
  }
  catch (err) {
    if (isUniqueViolation(err))
      throw new EncounterError("already_open");
    throw err;
  }

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "encounter.opened",
    entityType: "encounter",
    entityId: encounter.id,
    summary: `Opened ${input.kind === "opd" ? "an outpatient visit" : "an emergency attendance"}`,
    detail: { patientId: input.patientId, kind: input.kind },
  });
  return encounter;
}

/** Ends a visit. An admission ends by discharge instead. */
export async function closeEncounter(tx: AppDb, facilityId: string, id: string, actor: PatientActor, at = new Date()) {
  const encounter = await lockEncounter(tx, id);
  if (encounter.kind === "ipd")
    throw new EncounterError("use_discharge");

  const [closed] = await tx.update(encounters)
    .set({ status: "closed", endedAt: at, closedBy: actor.membershipId })
    .where(eq(encounters.id, id))
    .returning();

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "encounter.closed",
    entityType: "encounter",
    entityId: id,
    summary: "Closed the visit",
  });
  return closed;
}

/**
 * Cancels an encounter opened by mistake, for a stated reason. A cancelled
 * admission leaves its bed at once. One with charges still standing cannot
 * be cancelled: the charges are cancelled first, each for its own reason.
 */
export async function cancelEncounter(tx: AppDb, facilityId: string, id: string, reason: string, actor: PatientActor, at = new Date()) {
  const encounter = await lockEncounter(tx, id);
  if (await liveChargeCount(tx, id) > 0)
    throw new EncounterError("has_charges");

  if (encounter.kind === "ipd") {
    const [admission] = await tx.select({ id: admissions.id }).from(admissions).where(eq(admissions.encounterId, id)).limit(1);
    if (admission)
      await endOpenStay(tx, admission.id, at, actor);
  }

  const [cancelled] = await tx.update(encounters)
    .set({ status: "cancelled", endedAt: at, closedBy: actor.membershipId, cancelReason: reason })
    .where(eq(encounters.id, id))
    .returning();

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "encounter.cancelled",
    entityType: "encounter",
    entityId: id,
    summary: `Cancelled: ${reason}`,
    detail: { reason },
  });
  return cancelled;
}

// ---------------------------------------------------------------------------
// Admissions
// ---------------------------------------------------------------------------

/**
 * Admits a patient to a bed: an `ipd` encounter, the patient's IP number if
 * this is their first admission, an admission number, and the first stay.
 * One transaction, so a refusal spends no number.
 */
export async function admitPatient(
  tx: AppDb,
  facilityId: string,
  input: { patientId: string; bedId: string; parentEncounterId?: string },
  actor: PatientActor,
  at = new Date(),
): Promise<{ encounterId: string; admissionNumber: string; ipNumber: string }> {
  await patientExists(tx, input.patientId);

  if (input.parentEncounterId) {
    const [parent] = await tx.select({ patientId: encounters.patientId }).from(encounters).where(eq(encounters.id, input.parentEncounterId)).limit(1);
    if (!parent || parent.patientId !== input.patientId)
      throw new EncounterError("parent_mismatch");
  }

  const bed = await freeBed(tx, input.bedId);

  let encounter: EncounterRow;
  try {
    [encounter] = await tx.insert(encounters).values({
      facilityId,
      patientId: input.patientId,
      kind: "ipd",
      startedAt: at,
      openedBy: actor.membershipId,
      parentEncounterId: input.parentEncounterId ?? null,
    }).returning();
  }
  catch (err) {
    if (isUniqueViolation(err))
      throw new EncounterError("already_admitted");
    throw err;
  }

  const ipNumber = await inpatientNumber(tx, facilityId, input.patientId);
  const admissionNumber = await issueNumber(tx, facilityId, "admission", at);
  const [admission] = await tx.insert(admissions).values({
    facilityId,
    encounterId: encounter.id,
    admissionNumber,
    admittedAt: at,
    admittedBy: actor.membershipId,
  }).returning({ id: admissions.id });

  await startStay(tx, facilityId, admission.id, input.bedId, at, actor);

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "patient.admitted",
    entityType: "encounter",
    entityId: encounter.id,
    summary: `Admitted ${ipNumber} as ${admissionNumber} to ${bed.wardName} bed ${bed.label}`,
    detail: { patientId: input.patientId, admissionNumber, ipNumber, bedId: input.bedId },
  });

  return { encounterId: encounter.id, admissionNumber, ipNumber };
}

/** The patient's IP number, issued at their first admission and kept for life. */
async function inpatientNumber(tx: AppDb, facilityId: string, patientId: string): Promise<string> {
  const [existing] = await tx
    .select({ number: patientNumbers.number })
    .from(patientNumbers)
    .where(and(eq(patientNumbers.patientId, patientId), eq(patientNumbers.kind, "inpatient")))
    .limit(1);
  if (existing)
    return existing.number;

  const number = await issueNumber(tx, facilityId, "inpatient");
  await tx.insert(patientNumbers).values({ facilityId, patientId, kind: "inpatient", number });
  return number;
}

async function admissionOf(tx: AppDb, encounter: EncounterRow) {
  if (encounter.kind !== "ipd")
    throw new EncounterError("not_admitted");
  const [admission] = await tx.select().from(admissions).where(eq(admissions.encounterId, encounter.id)).limit(1);
  if (!admission)
    throw new EncounterError("not_admitted");
  return admission;
}

/** Moves an admitted patient to another bed: one stay ends as the next begins. */
export async function transferPatient(
  tx: AppDb,
  facilityId: string,
  encounterId: string,
  bedId: string,
  actor: PatientActor,
  at = new Date(),
) {
  const encounter = await lockEncounter(tx, encounterId);
  const admission = await admissionOf(tx, encounter);

  const [current] = await tx
    .select({ bedId: bedStays.bedId })
    .from(bedStays)
    .where(and(eq(bedStays.admissionId, admission.id), isNull(bedStays.endedAt)))
    .limit(1);
  if (current?.bedId === bedId)
    throw new EncounterError("same_bed");

  const bed = await freeBed(tx, bedId);
  await endOpenStay(tx, admission.id, at, actor);
  await startStay(tx, facilityId, admission.id, bedId, at, actor);

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "patient.transferred",
    entityType: "encounter",
    entityId: encounterId,
    summary: `Transferred ${admission.admissionNumber} to ${bed.wardName} bed ${bed.label}`,
    detail: { fromBedId: current?.bedId ?? null, toBedId: bedId },
  });
}

/**
 * Discharges an admitted patient: the stay ends, and so does the encounter,
 * and every bed-day up to now is charged (a same-day stay, one day).
 */
export async function dischargePatient(
  tx: AppDb,
  facilityId: string,
  encounterId: string,
  disposition: Disposition,
  actor: PatientActor,
  at = new Date(),
) {
  const encounter = await lockEncounter(tx, encounterId);
  const admission = await admissionOf(tx, encounter);

  await endOpenStay(tx, admission.id, at, actor);
  await tx.update(admissions)
    .set({ dischargedAt: at, dischargedBy: actor.membershipId, dischargeDisposition: disposition })
    .where(eq(admissions.id, admission.id));
  await tx.update(encounters)
    .set({ status: "closed", endedAt: at, closedBy: actor.membershipId })
    .where(eq(encounters.id, encounterId));
  await accrueBedDays(tx, facilityId, encounterId, at);

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "patient.discharged",
    entityType: "encounter",
    entityId: encounterId,
    summary: `Discharged ${admission.admissionNumber} (${disposition.replaceAll("_", " ")})`,
    detail: { disposition },
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface EncounterDetail extends Omit<EncounterRow, "facilityId" | "openedBy" | "closedBy" | "updatedAt"> {
  admission: null | {
    admissionNumber: string;
    admittedAt: Date;
    dischargedAt: Date | null;
    dischargeDisposition: Disposition | null;
    stays: { bedId: string; bedLabel: string; wardName: string; startedAt: Date; endedAt: Date | null }[];
  };
}

async function detail(tx: AppDb, encounter: EncounterRow): Promise<EncounterDetail> {
  const { facilityId: _f, openedBy: _o, closedBy: _c, updatedAt: _u, ...rest } = encounter;
  if (encounter.kind !== "ipd")
    return { ...rest, admission: null };

  const [admission] = await tx.select().from(admissions).where(eq(admissions.encounterId, encounter.id)).limit(1);
  if (!admission)
    return { ...rest, admission: null };

  const stays = await tx
    .select({ bedId: bedStays.bedId, bedLabel: beds.label, wardName: wards.name, startedAt: bedStays.startedAt, endedAt: bedStays.endedAt })
    .from(bedStays)
    .innerJoin(beds, eq(beds.id, bedStays.bedId))
    .innerJoin(wards, eq(wards.id, beds.wardId))
    .where(eq(bedStays.admissionId, admission.id))
    .orderBy(asc(bedStays.startedAt));

  return {
    ...rest,
    admission: {
      admissionNumber: admission.admissionNumber,
      admittedAt: admission.admittedAt,
      dischargedAt: admission.dischargedAt,
      dischargeDisposition: admission.dischargeDisposition,
      stays,
    },
  };
}

/** One encounter, with an audit entry: it is part of the patient's record (rule 9). */
export async function viewEncounter(tx: AppDb, facilityId: string, id: string, actor: PatientActor): Promise<EncounterDetail> {
  const [encounter] = await tx.select().from(encounters).where(eq(encounters.id, id)).limit(1);
  if (!encounter)
    throw new EncounterError("not_found");

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "encounter.viewed",
    entityType: "encounter",
    entityId: id,
    summary: "Opened an encounter",
    detail: { patientId: encounter.patientId },
  });
  return detail(tx, encounter);
}

/** An encounter's detail without an audit entry, for answering the act that changed it. */
export async function encounterDetail(tx: AppDb, id: string): Promise<EncounterDetail> {
  const [encounter] = await tx.select().from(encounters).where(eq(encounters.id, id)).limit(1);
  if (!encounter)
    throw new EncounterError("not_found");
  return detail(tx, encounter);
}

/** A patient's encounters, newest first, a page of 100 at a time, with an audit entry. */
export async function listEncounters(tx: AppDb, facilityId: string, patientId: string, actor: PatientActor, offset = 0) {
  await patientExists(tx, patientId);
  const rows = await tx
    .select()
    .from(encounters)
    .where(eq(encounters.patientId, patientId))
    .orderBy(desc(encounters.startedAt), desc(encounters.id))
    .limit(100)
    .offset(offset);

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "encounter.viewed",
    entityType: "patient",
    entityId: patientId,
    summary: `Listed a patient's encounters (${rows.length})`,
  });
  return Promise.all(rows.map(row => detail(tx, row)));
}
