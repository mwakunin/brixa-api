import { and, asc, eq, isNull } from "drizzle-orm";

import type { AppDb } from "@/db";

import { memberships, patientAllergies, patients, user } from "@/db/schema";

import type { PatientActor } from "./patients";

import { recordAudit } from "./audit";

/**
 * A patient's allergies (SCHEMA.md §8, P3 slice 2), or a recorded "no known
 * allergies": the difference between "asked, and there are none" and "never
 * asked" matters wherever a drug is prescribed. Changes for one patient are
 * serialized on the patient's row, so "no known allergies" and an allergy
 * cannot both stand.
 */

type AllergyRow = typeof patientAllergies.$inferSelect;
export type AllergyCategory = Exclude<AllergyRow["category"], "none_known">;
export type Severity = NonNullable<AllergyRow["severity"]>;
export type RemovalReason = NonNullable<AllergyRow["removalReason"]>;

export class AllergyError extends Error {
  constructor(readonly code: "patient_not_found" | "not_found" | "already_removed" | "has_allergies") {
    super({
      patient_not_found: "No such patient",
      not_found: "No such allergy",
      already_removed: "This allergy is no longer on the record",
      has_allergies: "This patient has allergies on record; remove them first if they were entered in error",
    }[code]);
    this.name = "AllergyError";
  }
}

async function lockPatient(tx: AppDb, patientId: string) {
  const [patient] = await tx.select({ id: patients.id }).from(patients).where(eq(patients.id, patientId)).for("update").limit(1);
  if (!patient)
    throw new AllergyError("patient_not_found");
}

const standing = (patientId: string) => and(eq(patientAllergies.patientId, patientId), isNull(patientAllergies.removedAt));

/**
 * Records an allergy, which ends a standing "no known allergies".
 */
export async function recordAllergy(
  tx: AppDb,
  facilityId: string,
  patientId: string,
  input: { category: AllergyCategory; allergen: string; reaction?: string; severity?: Severity },
  actor: PatientActor,
  now = new Date(),
): Promise<AllergyRow> {
  await lockPatient(tx, patientId);

  await tx.update(patientAllergies)
    .set({ removedAt: now, removedBy: actor.membershipId, removalReason: "no_longer_applies" })
    .where(and(standing(patientId), eq(patientAllergies.category, "none_known")));

  const [allergy] = await tx.insert(patientAllergies).values({
    facilityId,
    patientId,
    category: input.category,
    allergen: input.allergen,
    reaction: input.reaction ?? null,
    severity: input.severity ?? null,
    recordedAt: now,
    recordedBy: actor.membershipId,
  }).returning();

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "allergy.recorded",
    entityType: "patient",
    entityId: patientId,
    summary: `Recorded a ${input.category} allergy`,
    detail: { allergyId: allergy.id, category: input.category },
  });
  return allergy;
}

/**
 * Records that the patient has no known allergies. Refused while an allergy
 * stands; one already recorded is answered as it is, audited as a read.
 */
export async function recordNoKnownAllergies(
  tx: AppDb,
  facilityId: string,
  patientId: string,
  actor: PatientActor,
  now = new Date(),
): Promise<AllergyRow> {
  await lockPatient(tx, patientId);

  const current = await tx.select().from(patientAllergies).where(standing(patientId));
  if (current.some(a => a.category !== "none_known"))
    throw new AllergyError("has_allergies");
  const already = current.find(a => a.category === "none_known");
  if (already) {
    // Answered with who recorded it and when: a read of the record (rule 9).
    await recordAudit(tx, {
      facilityId,
      actorId: actor.userId,
      action: "patient.viewed",
      entityType: "patient",
      entityId: patientId,
      summary: "Viewed allergies: no known allergies, already recorded",
    });
    return already;
  }

  const [statement] = await tx.insert(patientAllergies).values({
    facilityId,
    patientId,
    category: "none_known",
    recordedAt: now,
    recordedBy: actor.membershipId,
  }).returning();

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "allergy.recorded",
    entityType: "patient",
    entityId: patientId,
    summary: "Recorded no known allergies",
    detail: { allergyId: statement.id, category: "none_known" },
  });
  return statement;
}

/** Ends an allergy (or "no known allergies"): entered in error, or no longer applying. */
export async function removeAllergy(
  tx: AppDb,
  facilityId: string,
  allergyId: string,
  reason: RemovalReason,
  actor: PatientActor,
  now = new Date(),
): Promise<AllergyRow> {
  const [found] = await tx.select({ patientId: patientAllergies.patientId }).from(patientAllergies).where(eq(patientAllergies.id, allergyId)).limit(1);
  if (!found)
    throw new AllergyError("not_found");
  await lockPatient(tx, found.patientId);

  const [current] = await tx.select().from(patientAllergies).where(eq(patientAllergies.id, allergyId)).limit(1);
  if (current.removedAt)
    throw new AllergyError("already_removed");

  const [removed] = await tx.update(patientAllergies)
    .set({ removedAt: now, removedBy: actor.membershipId, removalReason: reason })
    .where(eq(patientAllergies.id, allergyId))
    .returning();

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "allergy.removed",
    entityType: "patient",
    entityId: found.patientId,
    summary: reason === "entered_in_error" ? "Removed an allergy entered in error" : "Removed an allergy that no longer applies",
    detail: { allergyId, category: current.category, reason },
  });
  return removed;
}

/** A patient's allergies as staff see them, oldest first. Not audited: for answering a write. */
export async function allergiesOf(tx: AppDb, patientId: string, includeEnded = false) {
  const rows = await tx
    .select({ allergy: patientAllergies, recordedByName: user.name })
    .from(patientAllergies)
    .innerJoin(memberships, eq(memberships.id, patientAllergies.recordedBy))
    .innerJoin(user, eq(user.id, memberships.userId))
    .where(includeEnded ? eq(patientAllergies.patientId, patientId) : standing(patientId))
    .orderBy(asc(patientAllergies.recordedAt), asc(patientAllergies.id));

  return rows.map(({ allergy: a, recordedByName }) => ({
    id: a.id,
    category: a.category,
    allergen: a.allergen,
    reaction: a.reaction,
    severity: a.severity,
    recordedAt: a.recordedAt,
    recordedBy: { membershipId: a.recordedBy, name: recordedByName },
    removedAt: a.removedAt,
    removalReason: a.removalReason,
  }));
}

/**
 * A patient's standing allergies, or "no known allergies"; with
 * `includeEnded`, those ended too. An empty list means nobody has asked yet.
 * Audited as a view of the record (rule 9).
 */
export async function listAllergies(tx: AppDb, facilityId: string, patientId: string, actor: PatientActor, includeEnded = false) {
  const [patient] = await tx.select({ id: patients.id }).from(patients).where(eq(patients.id, patientId)).limit(1);
  if (!patient)
    throw new AllergyError("patient_not_found");

  const listed = await allergiesOf(tx, patientId, includeEnded);
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "patient.viewed",
    entityType: "patient",
    entityId: patientId,
    summary: `Viewed allergies (${listed.length})`,
  });
  return listed;
}
