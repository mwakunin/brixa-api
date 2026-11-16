import { and, desc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { AppDb } from "@/db";
import type { MembershipRole } from "@/db/schema";

import {
  breakGlassAlerts,
  breakGlassGrants,
  clinicalNotes,
  diagnoses,
  encounters,
  labReports,
  labTests,
  memberships,
  orderItems,
  orders,
  patientNumbers,
  patients,
  queueEntries,
  sensitiveDrugs,
  servicePoints,
  user,
} from "@/db/schema";

import type { PatientActor } from "./patients";

import { recordAudit } from "./audit";

/**
 * Sensitive records and break-glass (CLAUDE.md rule 27, SPEC.md D5; decided
 * 2026-11-15, ROADMAP.md P3).
 *
 * A record is restricted when it falls in a sensitive category: a diagnosis
 * under a code on the list below, a result or order of a lab test the
 * catalogue marks, a note its author marks, or anything clinical recorded in
 * a visit to a clinic the facility marks. Its reader sees it when they
 * recorded it, when the facility admin assigned them every category it is in,
 * or while they hold a break-glass grant for the patient. Anyone else sees a
 * placeholder: that a restricted record exists, and when, never its category.
 *
 * Only clinical reads are guarded here; vital signs, allergies, queues,
 * appointments and the bill are not restricted, and the lab's own worklist
 * is the lab's work.
 */

export const SENSITIVE_CATEGORIES = ["hiv", "mental_health", "gbv"] as const;
export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number];

// A compile error here means the list and the columns' type have drifted apart.
type ColumnCategory = NonNullable<(typeof servicePoints.$inferSelect)["sensitiveCategory"]>;
const _sameCategories: [Exclude<ColumnCategory, SensitiveCategory>, Exclude<SensitiveCategory, ColumnCategory>] extends [never, never] ? true : false = true;
void _sameCategories;

/** How long breaking the glass opens a patient's restricted records. */
export const BREAK_GLASS_HOURS = 12;

/**
 * ICD-11 codes whose diagnoses are restricted, by the start of the code. A
 * first list, to be confirmed by a clinician (ROADMAP.md P3, 2026-11-15):
 * HIV disease (1C60–1C62), and chapter 06, mental, behavioural or
 * neurodevelopmental disorders, whose codes all begin with 6. The GBV codes
 * are for a clinician to name; until then GBV is marked by its clinic and
 * by notes.
 */
const SENSITIVE_CODES: readonly (readonly [string, SensitiveCategory])[] = [
  ["1C60", "hiv"],
  ["1C61", "hiv"],
  ["1C62", "hiv"],
  ["6", "mental_health"],
];

export function categoryOfCode(code: string): SensitiveCategory | null {
  return SENSITIVE_CODES.find(([prefix]) => code.startsWith(prefix))?.[1] ?? null;
}

export class SensitivityError extends Error {
  constructor(readonly code: "patient_not_found" | "grant_not_found" | "already_reviewed" | "member_not_found") {
    super({
      patient_not_found: "No such patient",
      grant_not_found: "No such break-glass",
      already_reviewed: "This break-glass has already been reviewed",
      member_not_found: "No such member",
    }[code]);
    this.name = "SensitivityError";
  }
}

// ---------------------------------------------------------------------------
// Who may see what
// ---------------------------------------------------------------------------

/** Who is reading one patient's record, and what they see without breaking the glass. */
export interface Reader {
  membershipId: string;
  /** The categories the facility admin assigned them. */
  categories: ReadonlySet<SensitiveCategory>;
  /** Their break-glass grant for this patient, while it lasts. */
  grantId: string | null;
}

/** A record as this module judges it: the categories it falls in, and who recorded it. */
export interface Guarded {
  categories: ReadonlySet<SensitiveCategory>;
  recordedBy: readonly (string | null)[];
}

export type Sight = "open" | "via_grant" | "restricted";

export async function readerOf(tx: AppDb, patientId: string, actor: PatientActor, at = new Date()): Promise<Reader> {
  const [member] = await tx.select({ categories: memberships.sensitiveCategories }).from(memberships).where(eq(memberships.id, actor.membershipId)).limit(1);
  const [grant] = await tx
    .select({ id: breakGlassGrants.id })
    .from(breakGlassGrants)
    .where(and(eq(breakGlassGrants.patientId, patientId), eq(breakGlassGrants.grantedTo, actor.membershipId), gt(breakGlassGrants.expiresAt, at)))
    .orderBy(desc(breakGlassGrants.expiresAt))
    .limit(1);
  return { membershipId: actor.membershipId, categories: new Set(member?.categories ?? []), grantId: grant?.id ?? null };
}

/** Whether `reader` sees a record openly, only through their grant, or not at all. */
export function sight(reader: Reader, record: Guarded): Sight {
  if (record.categories.size === 0 || record.recordedBy.includes(reader.membershipId))
    return "open";
  if ([...record.categories].every(c => reader.categories.has(c)))
    return "open";
  return reader.grantId ? "via_grant" : "restricted";
}

/** The categories in `sets`, together. */
export function categoriesOf(...sets: (Iterable<SensitiveCategory | null> | null | undefined)[]): Set<SensitiveCategory> {
  const all = new Set<SensitiveCategory>();
  for (const set of sets) {
    for (const c of set ?? []) {
      if (c)
        all.add(c);
    }
  }
  return all;
}

/** The categories of the sensitive clinics each encounter's patient was queued at during it. */
export async function clinicCategoriesOf(tx: AppDb, encounterIds: readonly string[]): Promise<Map<string, Set<SensitiveCategory>>> {
  const found = new Map<string, Set<SensitiveCategory>>(encounterIds.map(id => [id, new Set()]));
  if (encounterIds.length === 0)
    return found;
  const rows = await tx
    .selectDistinct({ encounterId: queueEntries.encounterId, category: servicePoints.sensitiveCategory })
    .from(queueEntries)
    .innerJoin(servicePoints, eq(servicePoints.id, queueEntries.servicePointId))
    .where(and(inArray(queueEntries.encounterId, [...encounterIds]), isNotNull(servicePoints.sensitiveCategory)));
  for (const r of rows)
    found.get(r.encounterId)?.add(r.category!);
  return found;
}

/** What a reader is shown of a list: what they may see, a placeholder for the rest, and the grant if one was needed. */
export interface Filtered<T> {
  shown: T[];
  restricted: { recordedAt: Date }[];
  /** The grant some record was seen through, for the read's audit entry. */
  viaGrant: string | null;
  /** Who recorded the records seen through it: each is alerted (`alertRecorders`). */
  viaGrantRecorders: string[];
}

export function filterFor<T>(reader: Reader, records: readonly T[], guard: (record: T) => Guarded, recordedAt: (record: T) => Date): Filtered<T> {
  const shown: T[] = [];
  const restricted: { recordedAt: Date }[] = [];
  const recorders = new Set<string>();
  let viaGrant: string | null = null;
  for (const record of records) {
    const judged = guard(record);
    const seen = sight(reader, judged);
    if (seen === "restricted") {
      restricted.push({ recordedAt: recordedAt(record) });
      continue;
    }
    if (seen === "via_grant") {
      viaGrant = reader.grantId;
      for (const by of judged.recordedBy) {
        if (by)
          recorders.add(by);
      }
    }
    shown.push(record);
  }
  return { shown, restricted, viaGrant, viaGrantRecorders: [...recorders] };
}

/**
 * Alerts those who recorded what a grant has opened, once per grant each
 * (rule 27). Breaking the glass alerts the owners of the patient's
 * restricted records then; a record restricted since, or recorded since,
 * alerts its owner when the grant first opens it.
 */
export async function alertRecorders(tx: AppDb, facilityId: string, grantId: string | null, recorders: readonly (string | null)[], actor: PatientActor): Promise<void> {
  const owners = [...new Set(recorders.filter((by): by is string => Boolean(by) && by !== actor.membershipId))];
  if (!grantId || owners.length === 0)
    return;
  await tx
    .insert(breakGlassAlerts)
    .values(owners.map(membershipId => ({ facilityId, grantId, membershipId })))
    .onConflictDoNothing({ target: [breakGlassAlerts.grantId, breakGlassAlerts.membershipId] });
}

/** The audit detail of a read that hid records, or saw them through a grant. */
export function readDetail(filtered: { restricted: unknown[]; viaGrant: string | null }): Record<string, unknown> | undefined {
  if (filtered.restricted.length === 0 && !filtered.viaGrant)
    return undefined;
  return {
    ...(filtered.restricted.length > 0 ? { restricted: filtered.restricted.length } : {}),
    ...(filtered.viaGrant ? { breakGlassId: filtered.viaGrant } : {}),
  };
}

/** The patient an encounter is for. */
export async function patientOfEncounter(tx: AppDb, encounterId: string): Promise<string | null> {
  const [found] = await tx.select({ patientId: encounters.patientId }).from(encounters).where(eq(encounters.id, encounterId)).limit(1);
  return found?.patientId ?? null;
}

/**
 * Each order's guard: its lab tests' categories, its medicines' (a drug the
 * facility marked sensitive, P4 slice 3c) and its visit's clinics, recorded
 * by whoever ordered and entered it.
 */
export async function orderGuards(tx: AppDb, orderIds: readonly string[]): Promise<Map<string, Guarded & { encounterId: string; patientId: string }>> {
  if (orderIds.length === 0)
    return new Map();
  const rows = await tx
    .select({ id: orders.id, encounterId: orders.encounterId, patientId: encounters.patientId, orderedBy: orders.orderedBy, enteredBy: orders.enteredBy })
    .from(orders)
    .innerJoin(encounters, eq(encounters.id, orders.encounterId))
    .where(inArray(orders.id, [...orderIds]));
  const tests = await tx
    .selectDistinct({ orderId: orderItems.orderId, category: labTests.sensitiveCategory })
    .from(orderItems)
    .innerJoin(labTests, eq(labTests.id, orderItems.labTestId))
    .where(and(inArray(orderItems.orderId, [...orderIds]), isNotNull(labTests.sensitiveCategory)));
  const medicines = await tx
    .selectDistinct({ orderId: orderItems.orderId, category: sensitiveDrugs.category })
    .from(orderItems)
    .innerJoin(sensitiveDrugs, eq(sensitiveDrugs.drugCode, orderItems.drugCode))
    .where(and(inArray(orderItems.orderId, [...orderIds]), isNotNull(sensitiveDrugs.category)));
  const clinics = await clinicCategoriesOf(tx, [...new Set(rows.map(r => r.encounterId))]);
  return new Map(rows.map(r => [r.id, {
    encounterId: r.encounterId,
    patientId: r.patientId,
    categories: categoriesOf(
      clinics.get(r.encounterId),
      tests.filter(t => t.orderId === r.id).map(t => t.category),
      medicines.filter(m => m.orderId === r.id).map(m => m.category),
    ),
    recordedBy: [r.orderedBy, r.enteredBy],
  }]));
}

/**
 * Whether `actor` may not see a record judged by `guard`: for writes, which
 * answer with the record. One they see only through their grant is a read
 * through it, audited as one on the record's encounter, and its recorders
 * are alerted.
 */
export async function isRestricted(
  tx: AppDb,
  record: { facilityId: string; patientId: string; encounterId: string },
  guard: Guarded,
  actor: PatientActor,
): Promise<boolean> {
  if (guard.categories.size === 0)
    return false;
  const reader = await readerOf(tx, record.patientId, actor);
  const seen = sight(reader, guard);
  if (seen === "via_grant") {
    await alertRecorders(tx, record.facilityId, reader.grantId, guard.recordedBy, actor);
    await recordAudit(tx, {
      facilityId: record.facilityId,
      actorId: actor.userId,
      action: "encounter.viewed",
      entityType: "encounter",
      entityId: record.encounterId,
      summary: "Changed a restricted record through break-glass",
      detail: { breakGlassId: reader.grantId },
    });
  }
  return seen === "restricted";
}

/** The lab prints its own reports, and the pharmacy dispenses against prescriptions: their own work. */
const DOCUMENT_WORKERS: Partial<Record<"prescription" | "lab_report", readonly MembershipRole[]>> = {
  lab_report: ["lab_tech", "lab_supervisor"],
  prescription: ["pharmacist", "pharm_tech"],
};

/**
 * Whether `actor` may open a clinical document: a prescription or lab report
 * is judged with its order. Every other kind is not restricted here.
 */
export async function documentSight(
  tx: AppDb,
  document: { id: string; kind: string; facilityId: string },
  actor: PatientActor & { roles: readonly MembershipRole[] },
): Promise<{ sight: Sight; grantId: string | null }> {
  if (document.kind !== "prescription" && document.kind !== "lab_report")
    return { sight: "open", grantId: null };
  if (actor.roles.some(r => DOCUMENT_WORKERS[document.kind as "prescription" | "lab_report"]!.includes(r)))
    return { sight: "open", grantId: null };
  const [order] = document.kind === "prescription"
    ? await tx.select({ id: orders.id }).from(orders).where(eq(orders.documentId, document.id)).limit(1)
    : await tx.select({ id: labReports.orderId }).from(labReports).where(eq(labReports.documentId, document.id)).limit(1);
  if (!order)
    return { sight: "open", grantId: null };
  const guard = (await orderGuards(tx, [order.id])).get(order.id)!;
  const reader = await readerOf(tx, guard.patientId, actor);
  const seen = sight(reader, guard);
  if (seen === "via_grant")
    await alertRecorders(tx, document.facilityId, reader.grantId, guard.recordedBy, actor);
  return { sight: seen, grantId: seen === "via_grant" ? reader.grantId : null };
}

// ---------------------------------------------------------------------------
// Breaking the glass
// ---------------------------------------------------------------------------

/**
 * The members who recorded a patient's restricted records: told when someone
 * breaks the glass on them. Notes, diagnoses and orders; a result's owner is
 * the clinician who ordered it.
 */
async function ownersOf(tx: AppDb, patientId: string): Promise<Set<string>> {
  const visits = await tx.select({ id: encounters.id }).from(encounters).where(eq(encounters.patientId, patientId));
  const ids = visits.map(v => v.id);
  if (ids.length === 0)
    return new Set();
  const clinics = await clinicCategoriesOf(tx, ids);
  const sensitiveVisit = (id: string) => (clinics.get(id)?.size ?? 0) > 0;
  const owners = new Set<string>();

  const notes = await tx
    .select({ by: clinicalNotes.writtenBy, encounterId: clinicalNotes.encounterId, category: clinicalNotes.sensitiveCategory })
    .from(clinicalNotes)
    .where(and(inArray(clinicalNotes.encounterId, ids), eq(clinicalNotes.status, "signed"), isNull(clinicalNotes.addendumOf)));
  for (const n of notes) {
    if (n.category || sensitiveVisit(n.encounterId))
      owners.add(n.by);
  }
  const diagnosed = await tx
    .select({ by: diagnoses.diagnosedBy, encounterId: diagnoses.encounterId, code: diagnoses.icdCode })
    .from(diagnoses)
    .where(inArray(diagnoses.encounterId, ids));
  for (const d of diagnosed) {
    if (categoryOfCode(d.code) || sensitiveVisit(d.encounterId))
      owners.add(d.by);
  }
  const ordered = await tx.select({ id: orders.id }).from(orders).where(inArray(orders.encounterId, ids));
  for (const guard of (await orderGuards(tx, ordered.map(o => o.id))).values()) {
    // The ordering clinician; for a walk-in's request, whoever entered it.
    const owner = guard.recordedBy[0] ?? guard.recordedBy[1];
    if (guard.categories.size > 0 && owner)
      owners.add(owner);
  }
  return owners;
}

/**
 * Breaks the glass on a patient's restricted records for 12 hours, with a
 * reason, and alerts those who recorded them. Every read in that time is
 * still audited, marked with the grant.
 */
export async function breakGlass(tx: AppDb, facilityId: string, patientId: string, reason: string, actor: PatientActor, at = new Date()): Promise<typeof breakGlassGrants.$inferSelect> {
  const [patient] = await tx.select({ id: patients.id }).from(patients).where(eq(patients.id, patientId)).limit(1);
  if (!patient)
    throw new SensitivityError("patient_not_found");

  const [grant] = await tx.insert(breakGlassGrants).values({
    facilityId,
    patientId,
    grantedTo: actor.membershipId,
    reason,
    grantedAt: at,
    expiresAt: new Date(at.getTime() + BREAK_GLASS_HOURS * 3_600_000),
  }).returning();
  const owners = [...await ownersOf(tx, patientId)].filter(id => id !== actor.membershipId);
  if (owners.length > 0)
    await tx.insert(breakGlassAlerts).values(owners.map(membershipId => ({ facilityId, grantId: grant.id, membershipId })));

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "patient.break_glass",
    entityType: "patient",
    entityId: patientId,
    summary: `Broke the glass on restricted records for ${BREAK_GLASS_HOURS} hours`,
    detail: { breakGlassId: grant.id, expiresAt: grant.expiresAt.toISOString(), alerted: owners.length },
  });
  return grant;
}

export interface ListedBreakGlass {
  id: string;
  patient: { id: string; name: string; opNumber: string | null };
  grantedTo: { membershipId: string; name: string };
  reason: string;
  grantedAt: Date;
  expiresAt: Date;
  review: { at: Date; by: { membershipId: string; name: string }; note: string | null } | null;
}

const LIST_LIMIT = 100;

/**
 * Break-glass grants, latest first: every one for the facility admin, and for
 * a clinician those that alerted them. Audited.
 */
export async function listBreakGlass(
  tx: AppDb,
  facilityId: string,
  actor: PatientActor & { roles: readonly MembershipRole[] },
  filter: { unreviewed?: boolean; offset?: number } = {},
): Promise<ListedBreakGlass[]> {
  const grantee = alias(memberships, "grantee");
  const granteeUser = alias(user, "grantee_user");
  const reviewer = alias(memberships, "reviewer");
  const reviewerUser = alias(user, "reviewer_user");
  const admin = actor.roles.includes("facility_admin");
  const rows = await tx
    .select({
      grant: breakGlassGrants,
      givenName: patients.givenName,
      middleNames: patients.middleNames,
      familyName: patients.familyName,
      opNumber: patientNumbers.number,
      granteeName: granteeUser.name,
      reviewerName: reviewerUser.name,
    })
    .from(breakGlassGrants)
    .innerJoin(patients, eq(patients.id, breakGlassGrants.patientId))
    .leftJoin(patientNumbers, and(eq(patientNumbers.patientId, patients.id), eq(patientNumbers.kind, "outpatient")))
    .innerJoin(grantee, eq(grantee.id, breakGlassGrants.grantedTo))
    .innerJoin(granteeUser, eq(granteeUser.id, grantee.userId))
    .leftJoin(reviewer, eq(reviewer.id, breakGlassGrants.reviewedBy))
    .leftJoin(reviewerUser, eq(reviewerUser.id, reviewer.userId))
    .where(and(
      filter.unreviewed ? isNull(breakGlassGrants.reviewedAt) : undefined,
      admin
        ? undefined
        : sql`EXISTS (SELECT 1 FROM ${breakGlassAlerts} WHERE ${breakGlassAlerts.grantId} = ${breakGlassGrants.id} AND ${breakGlassAlerts.membershipId} = ${actor.membershipId})`,
    ))
    .orderBy(desc(breakGlassGrants.grantedAt), desc(breakGlassGrants.id))
    .limit(LIST_LIMIT)
    .offset(filter.offset ?? 0);

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "break_glass.listed",
    entityType: "break_glass",
    summary: `Listed break-glass grants (${rows.length})`,
    detail: { shown: rows.length, all: admin },
  });
  return rows.map(({ grant: g, ...r }) => ({
    id: g.id,
    patient: { id: g.patientId, name: [r.givenName, r.middleNames, r.familyName].filter(Boolean).join(" "), opNumber: r.opNumber },
    grantedTo: { membershipId: g.grantedTo, name: r.granteeName },
    reason: g.reason,
    grantedAt: g.grantedAt,
    expiresAt: g.expiresAt,
    review: g.reviewedAt ? { at: g.reviewedAt, by: { membershipId: g.reviewedBy!, name: r.reviewerName ?? "" }, note: g.reviewNote } : null,
  }));
}

/** The facility admin's review of one break-glass, once. */
export async function reviewBreakGlass(tx: AppDb, facilityId: string, id: string, note: string | null, actor: PatientActor, at = new Date()): Promise<typeof breakGlassGrants.$inferSelect> {
  const [grant] = await tx.select().from(breakGlassGrants).where(eq(breakGlassGrants.id, id)).for("update").limit(1);
  if (!grant)
    throw new SensitivityError("grant_not_found");
  if (grant.reviewedAt)
    throw new SensitivityError("already_reviewed");
  const [reviewed] = await tx
    .update(breakGlassGrants)
    .set({ reviewedAt: at, reviewedBy: actor.membershipId, reviewNote: note })
    .where(eq(breakGlassGrants.id, id))
    .returning();
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "break_glass.reviewed",
    entityType: "break_glass",
    entityId: id,
    summary: "Reviewed a break-glass",
    detail: { patientId: grant.patientId },
  });
  return reviewed;
}

/** The facility admin assigns the sensitive categories a member works with, audited with the old. */
export async function setSensitiveAccess(tx: AppDb, facilityId: string, membershipId: string, categories: readonly SensitiveCategory[], actor: PatientActor): Promise<SensitiveCategory[]> {
  const [member] = await tx
    .select({ categories: memberships.sensitiveCategories, isActive: memberships.isActive })
    .from(memberships)
    .where(eq(memberships.id, membershipId))
    .for("update")
    .limit(1);
  if (!member?.isActive)
    throw new SensitivityError("member_not_found");
  const next = SENSITIVE_CATEGORIES.filter(c => categories.includes(c));
  if (next.join() === [...member.categories].sort((a, b) => SENSITIVE_CATEGORIES.indexOf(a) - SENSITIVE_CATEGORIES.indexOf(b)).join())
    return next;
  await tx.update(memberships).set({ sensitiveCategories: next }).where(eq(memberships.id, membershipId));
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "membership.sensitive_access_changed",
    entityType: "membership",
    entityId: membershipId,
    summary: next.length > 0 ? `Assigned sensitive categories: ${next.join(", ")}` : "Removed every sensitive category",
    detail: { from: member.categories, to: next },
  });
  return next;
}
