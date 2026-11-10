import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { diagnoses, encounters, memberships, user } from "@/db/schema";

import type { PatientActor } from "./patients";

import { recordAudit } from "./audit";
import { codableIcd } from "./icd11";

/**
 * Diagnoses (SCHEMA.md §8, P3 slice 3a), coded in ICD-11 (rule 8) and made by
 * a licensed clinician (rule 25). The code's title, URI and release are
 * copied as diagnosed (rule 7, and WHO's licence).
 *
 * Every change for one encounter takes its row lock first (M8), so the one
 * standing principal diagnosis is kept under concurrency, with
 * `diagnoses_one_standing_principal` as the backstop.
 */

type DiagnosisRow = typeof diagnoses.$inferSelect;
export type Certainty = DiagnosisRow["certainty"];
export type EndReason = NonNullable<DiagnosisRow["endReason"]>;

export type DiagnosisErrorCode
  = | "encounter_not_found"
    | "not_open"
    | "encounter_cancelled"
    | "code_not_found"
    | "code_too_broad"
    | "code_retired"
    | "already_diagnosed"
    | "not_found"
    | "ended"
    | "not_provisional"
    | "already_principal";

export class DiagnosisError extends Error {
  constructor(readonly code: DiagnosisErrorCode) {
    super({
      encounter_not_found: "No such encounter",
      not_open: "A diagnosis is recorded on an open encounter",
      encounter_cancelled: "This encounter was cancelled",
      code_not_found: "No such ICD-11 code",
      code_too_broad: "That code has more specific codes under it; choose one of them",
      code_retired: "That code is not in the current ICD-11 release",
      already_diagnosed: "This diagnosis is already recorded on the encounter",
      not_found: "No such diagnosis",
      ended: "This diagnosis was ruled out or entered in error",
      not_provisional: "Only a provisional diagnosis is confirmed",
      already_principal: "This is already the principal diagnosis",
    }[code]);
    this.name = "DiagnosisError";
  }
}

async function lockEncounter(tx: AppDb, encounterId: string) {
  const [encounter] = await tx
    .select({ id: encounters.id, status: encounters.status })
    .from(encounters)
    .where(eq(encounters.id, encounterId))
    .for("update")
    .limit(1);
  if (!encounter)
    throw new DiagnosisError("encounter_not_found");
  return encounter;
}

/** A standing diagnosis, locked after its encounter (M8). An ended one is refused. */
async function lockStanding(tx: AppDb, diagnosisId: string): Promise<DiagnosisRow> {
  const [found] = await tx.select({ encounterId: diagnoses.encounterId }).from(diagnoses).where(eq(diagnoses.id, diagnosisId)).limit(1);
  if (!found)
    throw new DiagnosisError("not_found");
  const encounter = await lockEncounter(tx, found.encounterId);
  if (encounter.status === "cancelled")
    throw new DiagnosisError("encounter_cancelled");
  const [diagnosis] = await tx.select().from(diagnoses).where(eq(diagnoses.id, diagnosisId)).for("update").limit(1);
  if (diagnosis.endedAt)
    throw new DiagnosisError("ended");
  return diagnosis;
}

const standing = (encounterId: string) => and(eq(diagnoses.encounterId, encounterId), isNull(diagnoses.endedAt));

async function demotePrincipal(tx: AppDb, encounterId: string, except?: string) {
  await tx.update(diagnoses)
    .set({ rank: "secondary" })
    .where(and(standing(encounterId), eq(diagnoses.rank, "principal"), except ? ne(diagnoses.id, except) : undefined));
}

/**
 * Records a diagnosis on an open encounter. The first standing one is the
 * principal; a later one is secondary unless `principal` says otherwise,
 * which makes the earlier principal secondary.
 */
export async function recordDiagnosis(
  tx: AppDb,
  facilityId: string,
  encounterId: string,
  input: { code: string; certainty: Certainty; principal?: boolean },
  actor: PatientActor,
  now = new Date(),
): Promise<DiagnosisRow> {
  const encounter = await lockEncounter(tx, encounterId);
  if (encounter.status !== "open")
    throw new DiagnosisError("not_open");

  const icd = await codableIcd(tx, input.code);
  if (!icd)
    throw new DiagnosisError("code_not_found");
  if (icd.retiredAt)
    throw new DiagnosisError("code_retired");
  if (!icd.isLeaf)
    throw new DiagnosisError("code_too_broad");

  const current = await tx.select({ code: diagnoses.icdCode, rank: diagnoses.rank }).from(diagnoses).where(standing(encounterId));
  if (current.some(d => d.code === icd.code))
    throw new DiagnosisError("already_diagnosed");
  const principal = input.principal === true || !current.some(d => d.rank === "principal");
  if (principal)
    await demotePrincipal(tx, encounterId);

  const [diagnosis] = await tx.insert(diagnoses).values({
    facilityId,
    encounterId,
    icdCode: icd.code,
    icdTitle: icd.title,
    icdUri: icd.uri,
    icdRelease: icd.release,
    certainty: input.certainty,
    rank: principal ? "principal" : "secondary",
    diagnosedAt: now,
    diagnosedBy: actor.membershipId,
  }).returning();

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "diagnosis.recorded",
    entityType: "encounter",
    entityId: encounterId,
    summary: `Recorded a ${input.certainty} ${diagnosis.rank} diagnosis, ${icd.code}`,
    detail: { diagnosisId: diagnosis.id, code: icd.code, certainty: input.certainty, rank: diagnosis.rank },
  });
  return diagnosis;
}

/** Confirms a provisional diagnosis, e.g. once a test bears it out. Also after the visit has closed. */
export async function confirmDiagnosis(tx: AppDb, facilityId: string, diagnosisId: string, actor: PatientActor, now = new Date()) {
  const current = await lockStanding(tx, diagnosisId);
  if (current.certainty !== "provisional")
    throw new DiagnosisError("not_provisional");

  const [confirmed] = await tx.update(diagnoses)
    .set({ certainty: "confirmed", confirmedAt: now, confirmedBy: actor.membershipId })
    .where(eq(diagnoses.id, diagnosisId))
    .returning();
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "diagnosis.confirmed",
    entityType: "encounter",
    entityId: current.encounterId,
    summary: `Confirmed ${current.icdCode}`,
    detail: { diagnosisId, code: current.icdCode },
  });
  return confirmed;
}

/** Makes a standing diagnosis the principal one; the previous principal becomes secondary. */
export async function makePrincipal(tx: AppDb, facilityId: string, diagnosisId: string, actor: PatientActor) {
  const current = await lockStanding(tx, diagnosisId);
  if (current.rank === "principal")
    throw new DiagnosisError("already_principal");

  await demotePrincipal(tx, current.encounterId, diagnosisId);
  const [principal] = await tx.update(diagnoses).set({ rank: "principal" }).where(eq(diagnoses.id, diagnosisId)).returning();
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "diagnosis.principal_set",
    entityType: "encounter",
    entityId: current.encounterId,
    summary: `Made ${current.icdCode} the principal diagnosis`,
    detail: { diagnosisId, code: current.icdCode },
  });
  return principal;
}

/** Ends a diagnosis: ruled out, or entered in error. It stays on the record, ended. */
export async function endDiagnosis(tx: AppDb, facilityId: string, diagnosisId: string, reason: EndReason, actor: PatientActor, now = new Date()) {
  const current = await lockStanding(tx, diagnosisId);

  const [ended] = await tx.update(diagnoses)
    .set({ endedAt: now, endedBy: actor.membershipId, endReason: reason })
    .where(eq(diagnoses.id, diagnosisId))
    .returning();
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "diagnosis.ended",
    entityType: "encounter",
    entityId: current.encounterId,
    summary: `${reason === "ruled_out" ? "Ruled out" : "Marked entered in error:"} ${current.icdCode}`,
    detail: { diagnosisId, code: current.icdCode, reason },
  });
  return ended;
}

/** Whether any diagnosis on the encounter still stands. */
export async function hasStandingDiagnoses(tx: AppDb, encounterId: string): Promise<boolean> {
  const [row] = await tx.select({ id: diagnoses.id }).from(diagnoses).where(standing(encounterId)).limit(1);
  return Boolean(row);
}

/** An encounter's diagnoses, principal first, then in the order made; ended ones included and marked. Not audited. */
export async function diagnosesOf(tx: AppDb, encounterId: string) {
  const rows = await tx
    .select({ diagnosis: diagnoses, diagnosedByName: user.name })
    .from(diagnoses)
    .innerJoin(memberships, eq(memberships.id, diagnoses.diagnosedBy))
    .innerJoin(user, eq(user.id, memberships.userId))
    .where(eq(diagnoses.encounterId, encounterId))
    .orderBy(asc(sql`${diagnoses.endedAt} IS NOT NULL`), asc(diagnoses.rank), asc(diagnoses.diagnosedAt), asc(diagnoses.id));

  return rows.map(({ diagnosis: d, diagnosedByName }) => ({
    id: d.id,
    code: d.icdCode,
    title: d.icdTitle,
    uri: d.icdUri,
    release: d.icdRelease,
    certainty: d.certainty,
    rank: d.rank,
    diagnosedAt: d.diagnosedAt,
    diagnosedBy: { membershipId: d.diagnosedBy, name: diagnosedByName },
    confirmedAt: d.confirmedAt,
    endedAt: d.endedAt,
    endReason: d.endReason,
  }));
}

/** As `diagnosesOf`, with an audit entry: they are part of the record (rule 9). */
export async function listDiagnoses(tx: AppDb, facilityId: string, encounterId: string, actor: PatientActor) {
  const [encounter] = await tx.select({ id: encounters.id }).from(encounters).where(eq(encounters.id, encounterId)).limit(1);
  if (!encounter)
    throw new DiagnosisError("encounter_not_found");

  const listed = await diagnosesOf(tx, encounterId);
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "encounter.viewed",
    entityType: "encounter",
    entityId: encounterId,
    summary: `Viewed diagnoses (${listed.length})`,
  });
  return listed;
}
