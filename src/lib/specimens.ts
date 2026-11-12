import type { SQL } from "drizzle-orm";

import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";

import type { AppDb } from "@/db";
import type { MembershipRole } from "@/db/schema";

import {
  billableItems,
  chargeAssignments,
  charges,
  encounters,
  invoiceLines,
  invoices,
  labResults,
  labTests,
  memberships,
  orderItems,
  orders,
  patientNumbers,
  patients,
  specimens,
  specimenTests,
  user,
} from "@/db/schema";

import type { ShownResult } from "./lab-results";
import type { OrderActor } from "./orders";
import type { PatientActor } from "./patients";

import { recordAudit } from "./audit";
import { ageInYears } from "./dates";
import { isUniqueViolation } from "./db-errors";
import { balanceCents } from "./invoice-balance";
import { hasResults, pendingResults } from "./lab-results";
import { issueNumber } from "./number-series";

/**
 * Specimens (SCHEMA.md §8, P3 slice 5a), decided 2026-11-11: a specimen is
 * taken for ordered lab tests of one type on one order, and takes the next
 * accession number of the day. Taking it marks its tests done, so they can no
 * longer be cancelled and their charges stand. Taken by the lab, it is
 * received at once; taken by a nurse, the lab receives it. A rejected
 * specimen keeps its number, and its tests are recollected on a new one.
 *
 * The lab's worklist shows what is waiting, urgent first, then oldest, with
 * a warning on a test not yet paid for at an outpatient visit; the warning
 * never blocks the work (decided 2026-11-10).
 *
 * Collection locks the encounter, then its items (M8); receiving and
 * rejecting lock only the specimen, which no money hangs on.
 */

type SpecimenRow = typeof specimens.$inferSelect;
export type SpecimenType = SpecimenRow["specimenType"];
export type SpecimenStatus = SpecimenRow["status"];
export type RejectionReason = NonNullable<SpecimenRow["rejectionReason"]>;

/** Who takes a specimen: the lab, and nurses on the wards and at the clinics. */
export const COLLECTING_STAFF = ["lab_tech", "lab_supervisor", "nurse", "ward_nurse"] as const;
/** Who receives and rejects specimens, and works from the worklist. */
export const LAB_STAFF = ["lab_tech", "lab_supervisor"] as const;

const WORKLIST_LIMIT = 200;

export type SpecimenErrorCode
  = | "order_not_found"
    | "nothing_to_collect"
    | "not_collectable"
    | "not_found"
    | "already_received"
    | "already_rejected"
    | "has_results"
    | "not_rejected"
    | "already_recollected";

export class SpecimenError extends Error {
  constructor(readonly code: SpecimenErrorCode) {
    super({
      order_not_found: "No such order",
      nothing_to_collect: "No test of that specimen type on this order is waiting to be collected",
      not_collectable: "Each test must be a lab test on this order, of this specimen type, not yet collected or cancelled",
      not_found: "No such specimen",
      already_received: "This specimen has already been received",
      already_rejected: "This specimen was rejected; recollect it instead",
      has_results: "This specimen has results; correct them rather than rejecting it",
      not_rejected: "Only a rejected specimen is recollected",
      already_recollected: "This specimen has already been recollected; recollect the new one if that was rejected too",
    }[code]);
    this.name = "SpecimenError";
  }
}

function isLab(roles: readonly MembershipRole[]): boolean {
  return roles.some(r => (LAB_STAFF as readonly string[]).includes(r));
}

async function lockEncounterOf(tx: AppDb, orderId: string): Promise<string> {
  const [order] = await tx.select({ encounterId: orders.encounterId }).from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order)
    throw new SpecimenError("order_not_found");
  await tx.select({ id: encounters.id }).from(encounters).where(eq(encounters.id, order.encounterId)).for("update");
  return order.encounterId;
}

/** Writes a specimen for `itemIds`, numbered now; received at once when the lab took it. */
async function writeSpecimen(
  tx: AppDb,
  facilityId: string,
  input: { orderId: string; specimenType: SpecimenType; itemIds: string[]; recollectionOf?: string },
  actor: OrderActor,
  at: Date,
): Promise<SpecimenRow> {
  const accessionNumber = await issueNumber(tx, facilityId, "lab_accession", at);
  const received = isLab(actor.roles);
  let specimen: SpecimenRow;
  try {
    [specimen] = await tx.insert(specimens).values({
      facilityId,
      orderId: input.orderId,
      accessionNumber,
      specimenType: input.specimenType,
      status: received ? "received" : "collected",
      collectedAt: at,
      collectedBy: actor.membershipId,
      receivedAt: received ? at : null,
      receivedBy: received ? actor.membershipId : null,
      recollectionOf: input.recollectionOf ?? null,
    }).returning();
  }
  catch (err) {
    if (isUniqueViolation(err) && input.recollectionOf)
      throw new SpecimenError("already_recollected");
    throw err;
  }
  await tx.insert(specimenTests).values(input.itemIds.map(orderItemId => ({ facilityId, specimenId: specimen.id, orderItemId })));
  return specimen;
}

/**
 * Takes a specimen for ordered lab tests on one order, all of one specimen
 * type: those named, or else every such test still waiting. Marks them done.
 */
export async function collectSpecimen(
  tx: AppDb,
  facilityId: string,
  orderId: string,
  input: { specimenType: SpecimenType; orderItemIds?: string[] },
  actor: OrderActor,
  at = new Date(),
): Promise<SpecimenRow> {
  const encounterId = await lockEncounterOf(tx, orderId);
  const items = await tx
    .select({ id: orderItems.id, status: orderItems.status, specimenType: orderItems.specimenType })
    .from(orderItems)
    .where(and(eq(orderItems.orderId, orderId), isNotNull(orderItems.labTestId)))
    .orderBy(asc(orderItems.id))
    .for("update");
  const waiting = items.filter(i => i.status === "ordered" && i.specimenType === input.specimenType).map(i => i.id);

  const itemIds = input.orderItemIds ?? waiting;
  if (itemIds.length === 0)
    throw new SpecimenError("nothing_to_collect");
  if (new Set(itemIds).size !== itemIds.length || !itemIds.every(id => waiting.includes(id)))
    throw new SpecimenError("not_collectable");

  const specimen = await writeSpecimen(tx, facilityId, { orderId, specimenType: input.specimenType, itemIds }, actor, at);
  await tx.update(orderItems)
    .set({ status: "done", doneAt: at, doneBy: actor.membershipId })
    .where(inArray(orderItems.id, itemIds));

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "specimen.collected",
    entityType: "encounter",
    entityId: encounterId,
    summary: `Collected specimen ${specimen.accessionNumber} (${input.specimenType}, ${itemIds.length} test(s))`,
    detail: { specimenId: specimen.id, accessionNumber: specimen.accessionNumber, orderItemIds: itemIds, received: specimen.status === "received" },
  });
  return specimen;
}

async function lockSpecimen(tx: AppDb, id: string): Promise<SpecimenRow> {
  const [specimen] = await tx.select().from(specimens).where(eq(specimens.id, id)).for("update").limit(1);
  if (!specimen)
    throw new SpecimenError("not_found");
  return specimen;
}

/** The lab receives a specimen a nurse took. */
export async function receiveSpecimen(tx: AppDb, facilityId: string, id: string, actor: PatientActor, at = new Date()): Promise<SpecimenRow> {
  const current = await lockSpecimen(tx, id);
  if (current.status === "received")
    throw new SpecimenError("already_received");
  if (current.status === "rejected")
    throw new SpecimenError("already_rejected");

  const [received] = await tx.update(specimens)
    .set({ status: "received", receivedAt: at, receivedBy: actor.membershipId })
    .where(eq(specimens.id, id))
    .returning();
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "specimen.received",
    entityType: "specimen",
    entityId: id,
    summary: `Received specimen ${received.accessionNumber}`,
  });
  return received;
}

/** Rejects a specimen that cannot be tested, for a reason from the list; it keeps its number. */
export async function rejectSpecimen(
  tx: AppDb,
  facilityId: string,
  id: string,
  input: { reason: RejectionReason; note?: string },
  actor: PatientActor,
  at = new Date(),
): Promise<SpecimenRow> {
  const current = await lockSpecimen(tx, id);
  if (current.status === "rejected")
    throw new SpecimenError("already_rejected");
  if (await hasResults(tx, id))
    throw new SpecimenError("has_results");

  const [rejected] = await tx.update(specimens)
    .set({ status: "rejected", rejectedAt: at, rejectedBy: actor.membershipId, rejectionReason: input.reason, rejectionNote: input.note ?? null })
    .where(eq(specimens.id, id))
    .returning();
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "specimen.rejected",
    entityType: "specimen",
    entityId: id,
    summary: `Rejected specimen ${rejected.accessionNumber}: ${input.reason.replaceAll("_", " ")}`,
    detail: { reason: input.reason, note: input.note ?? null },
  });
  return rejected;
}

/** Takes a rejected specimen again: a new specimen, with a new number, for the same tests. */
export async function recollectSpecimen(tx: AppDb, facilityId: string, id: string, actor: OrderActor, at = new Date()): Promise<SpecimenRow> {
  const [found] = await tx.select({ orderId: specimens.orderId }).from(specimens).where(eq(specimens.id, id)).limit(1);
  if (!found)
    throw new SpecimenError("not_found");
  const encounterId = await lockEncounterOf(tx, found.orderId);
  const rejected = await lockSpecimen(tx, id);
  if (rejected.status !== "rejected")
    throw new SpecimenError("not_rejected");

  const tests = await tx.select({ orderItemId: specimenTests.orderItemId }).from(specimenTests).where(eq(specimenTests.specimenId, id));
  const itemIds = tests.map(t => t.orderItemId);
  const specimen = await writeSpecimen(tx, facilityId, { orderId: rejected.orderId, specimenType: rejected.specimenType, itemIds, recollectionOf: id }, actor, at);

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "specimen.collected",
    entityType: "encounter",
    entityId: encounterId,
    summary: `Recollected specimen ${rejected.accessionNumber} as ${specimen.accessionNumber}`,
    detail: { specimenId: specimen.id, accessionNumber: specimen.accessionNumber, orderItemIds: itemIds, recollectionOf: id, received: specimen.status === "received" },
  });
  return specimen;
}

// ---------------------------------------------------------------------------
// Paid or not, and the worklist
// ---------------------------------------------------------------------------

/**
 * The charges paid for: each on finalised bills only, every one of which
 * owes nothing, for its whole amount (decided 2026-11-11). Derived (rule 4).
 */
export async function paidCharges(tx: AppDb, chargeIds: string[]): Promise<Set<string>> {
  if (chargeIds.length === 0)
    return new Set();
  const rows = await tx
    .select({
      chargeId: charges.id,
      chargeCents: charges.amountCents,
      assignedCents: chargeAssignments.amountCents,
      invoiceId: invoices.id,
      invoiceStatus: invoices.status,
      invoiceTotalCents: invoices.totalCents,
    })
    .from(charges)
    .innerJoin(chargeAssignments, eq(chargeAssignments.chargeId, charges.id))
    .innerJoin(invoiceLines, eq(invoiceLines.id, chargeAssignments.invoiceLineId))
    .innerJoin(invoices, and(eq(invoices.id, invoiceLines.invoiceId), ne(invoices.status, "void")))
    .where(inArray(charges.id, chargeIds));

  const owing = new Map<string, number>();
  for (const r of rows.filter(r => r.invoiceStatus === "finalised")) {
    if (!owing.has(r.invoiceId))
      owing.set(r.invoiceId, await balanceCents(tx, { id: r.invoiceId, totalCents: r.invoiceTotalCents }));
  }

  const paid = new Set<string>();
  for (const chargeId of new Set(rows.map(r => r.chargeId))) {
    const mine = rows.filter(r => r.chargeId === chargeId);
    const assigned = mine.reduce((sum, r) => sum + r.assignedCents, 0);
    if (assigned >= mine[0].chargeCents && mine.every(r => r.invoiceStatus === "finalised" && owing.get(r.invoiceId)! <= 0))
      paid.add(chargeId);
  }
  return paid;
}

export interface WorklistPatient {
  id: string;
  name: string;
  opNumber: string | null;
  sex: (typeof patients.$inferSelect)["sex"];
  ageYears: number;
}

export interface WorklistTest {
  orderItemId: string;
  code: string;
  name: string;
  /** Not yet paid for, at an outpatient visit: a warning, never a block. */
  unpaid: boolean;
}

/** Ordered lab tests of one specimen type on one order, waiting to be collected. */
export interface CollectionDue {
  orderId: string;
  encounterId: string;
  urgency: (typeof orders.$inferSelect)["urgency"];
  orderedAt: Date;
  patient: WorklistPatient;
  specimenType: SpecimenType;
  tests: WorklistTest[];
}

export interface ShownSpecimen {
  id: string;
  accessionNumber: string;
  orderId: string;
  encounterId: string;
  urgency: (typeof orders.$inferSelect)["urgency"];
  specimenType: SpecimenType;
  status: SpecimenStatus;
  collectedAt: Date;
  collectedBy: { membershipId: string; name: string };
  receivedAt: Date | null;
  rejectedAt: Date | null;
  rejectionReason: RejectionReason | null;
  rejectionNote: string | null;
  recollectionOf: string | null;
  patient: WorklistPatient;
  tests: WorklistTest[];
}

export interface Worklist {
  toCollect: CollectionDue[];
  /** Taken by a nurse, not yet in the lab. */
  toReceive: ShownSpecimen[];
  /** In the lab, with a test still to be resulted. */
  inLab: ShownSpecimen[];
  /** Results entered or released unverified, for another lab member to verify. */
  toVerify: ShownResult[];
}

const patientColumns = {
  patientId: patients.id,
  givenName: patients.givenName,
  middleNames: patients.middleNames,
  familyName: patients.familyName,
  sex: patients.sex,
  dateOfBirth: patients.dateOfBirth,
  opNumber: patientNumbers.number,
};

function patientOf(r: { patientId: string; givenName: string; middleNames: string | null; familyName: string; sex: WorklistPatient["sex"]; dateOfBirth: string; opNumber: string | null }, today?: string): WorklistPatient {
  return {
    id: r.patientId,
    name: [r.givenName, r.middleNames, r.familyName].filter(Boolean).join(" "),
    opNumber: r.opNumber,
    sex: r.sex,
    ageYears: ageInYears(r.dateOfBirth, today),
  };
}

/** Each item's test code and name, and whether it is unpaid at an outpatient visit. */
async function testsOf(tx: AppDb, itemIds: string[]): Promise<Map<string, WorklistTest>> {
  if (itemIds.length === 0)
    return new Map();
  const rows = await tx
    .select({ orderItemId: orderItems.id, code: billableItems.code, name: billableItems.name, chargeId: charges.id, kind: encounters.kind })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(encounters, eq(encounters.id, orders.encounterId))
    .innerJoin(labTests, eq(labTests.id, orderItems.labTestId))
    .innerJoin(billableItems, eq(billableItems.id, labTests.billableItemId))
    .leftJoin(charges, and(eq(charges.orderItemId, orderItems.id), isNull(charges.cancelledAt)))
    .where(inArray(orderItems.id, itemIds));
  const paid = await paidCharges(tx, rows.flatMap(r => (r.chargeId ? [r.chargeId] : [])));
  return new Map(rows.map(r => [r.orderItemId, {
    orderItemId: r.orderItemId,
    code: r.code,
    name: r.name,
    // An emergency or an admission is never held up over money (decided 2026-11-10/11).
    unpaid: r.kind === "opd" && !(r.chargeId && paid.has(r.chargeId)),
  }]));
}

/** Specimens as the lab sees them, most urgent first, then oldest. */
export async function specimensWhere(tx: AppDb, where: SQL | undefined, today?: string): Promise<ShownSpecimen[]> {
  const rows = await tx
    .select({ specimen: specimens, urgency: orders.urgency, encounterId: orders.encounterId, collectedByName: user.name, ...patientColumns })
    .from(specimens)
    .innerJoin(orders, eq(orders.id, specimens.orderId))
    .innerJoin(encounters, eq(encounters.id, orders.encounterId))
    .innerJoin(patients, eq(patients.id, encounters.patientId))
    .leftJoin(patientNumbers, and(eq(patientNumbers.patientId, patients.id), eq(patientNumbers.kind, "outpatient")))
    .innerJoin(memberships, eq(memberships.id, specimens.collectedBy))
    .innerJoin(user, eq(user.id, memberships.userId))
    .where(where)
    .orderBy(asc(sql`CASE ${orders.urgency} WHEN 'urgent' THEN 0 ELSE 1 END`), asc(specimens.collectedAt), asc(specimens.id))
    .limit(WORKLIST_LIMIT);
  if (rows.length === 0)
    return [];

  const links = await tx
    .select({ specimenId: specimenTests.specimenId, orderItemId: specimenTests.orderItemId })
    .from(specimenTests)
    .where(inArray(specimenTests.specimenId, rows.map(r => r.specimen.id)));
  const tests = await testsOf(tx, [...new Set(links.map(l => l.orderItemId))]);

  return rows.map((r) => {
    const s = r.specimen;
    return {
      id: s.id,
      accessionNumber: s.accessionNumber,
      orderId: s.orderId,
      encounterId: r.encounterId,
      urgency: r.urgency,
      specimenType: s.specimenType,
      status: s.status,
      collectedAt: s.collectedAt,
      collectedBy: { membershipId: s.collectedBy, name: r.collectedByName },
      receivedAt: s.receivedAt,
      rejectedAt: s.rejectedAt,
      rejectionReason: s.rejectionReason,
      rejectionNote: s.rejectionNote,
      recollectionOf: s.recollectionOf,
      patient: patientOf(r, today),
      tests: links.filter(l => l.specimenId === s.id).map(l => tests.get(l.orderItemId)!).sort((a, b) => a.code.localeCompare(b.code)),
    };
  });
}

/** One specimen as the lab sees it. Not audited: for answering a write. */
export async function specimenShown(tx: AppDb, id: string): Promise<ShownSpecimen> {
  const [shown] = await specimensWhere(tx, eq(specimens.id, id));
  if (!shown)
    throw new SpecimenError("not_found");
  return shown;
}

/**
 * The lab's worklist: tests waiting to be collected on open encounters, then
 * specimens waiting to be received, then those in the lab. Audited, since it
 * names patients and what they are tested for (rule 9).
 */
export async function viewWorklist(tx: AppDb, facilityId: string, actor: PatientActor, today?: string): Promise<Worklist> {
  const due = await tx
    .select({
      orderItemId: orderItems.id,
      orderId: orders.id,
      encounterId: orders.encounterId,
      urgency: orders.urgency,
      orderedAt: orders.orderedAt,
      specimenType: orderItems.specimenType,
      ...patientColumns,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(encounters, and(eq(encounters.id, orders.encounterId), eq(encounters.status, "open")))
    .innerJoin(patients, eq(patients.id, encounters.patientId))
    .leftJoin(patientNumbers, and(eq(patientNumbers.patientId, patients.id), eq(patientNumbers.kind, "outpatient")))
    .where(and(eq(orderItems.status, "ordered"), isNotNull(orderItems.labTestId)))
    // An order's specimen types in a fixed order, so its groups do not shuffle between views.
    .orderBy(asc(sql`CASE ${orders.urgency} WHEN 'urgent' THEN 0 ELSE 1 END`), asc(orders.orderedAt), asc(orders.id), asc(orderItems.specimenType))
    .limit(WORKLIST_LIMIT * 5);
  const tests = await testsOf(tx, due.map(d => d.orderItemId));

  const groups = new Map<string, CollectionDue>();
  for (const d of due) {
    const key = `${d.orderId}|${d.specimenType}`;
    const group = groups.get(key) ?? {
      orderId: d.orderId,
      encounterId: d.encounterId,
      urgency: d.urgency,
      orderedAt: d.orderedAt,
      patient: patientOf(d, today),
      // A lab item always has one (`order_items_specimen_type_of_a_test`).
      specimenType: d.specimenType!,
      tests: [],
    };
    group.tests.push(tests.get(d.orderItemId)!);
    groups.set(key, group);
  }
  const toCollect = [...groups.values()].slice(0, WORKLIST_LIMIT);
  for (const group of toCollect)
    group.tests.sort((a, b) => a.code.localeCompare(b.code));

  const toReceive = await specimensWhere(tx, eq(specimens.status, "collected"), today);
  const inLab = await specimensWhere(tx, and(eq(specimens.status, "received"), sql`EXISTS (
    SELECT 1 FROM ${specimenTests} st WHERE st.specimen_id = ${specimens.id}
      AND NOT EXISTS (SELECT 1 FROM ${labResults} r
        WHERE r.specimen_id = st.specimen_id AND r.order_item_id = st.order_item_id AND r.status <> 'superseded')
  )`), today);
  const toVerify = await pendingResults(tx);

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "lab.worklist_viewed",
    entityType: "facility",
    entityId: facilityId,
    summary: `Viewed the lab worklist (${toCollect.length} to collect, ${toReceive.length} to receive, ${inLab.length} in the lab, ${toVerify.length} to verify)`,
  });
  return { toCollect, toReceive, inLab, toVerify };
}
