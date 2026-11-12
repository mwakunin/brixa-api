import type { SQL } from "drizzle-orm";

import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { AppDb } from "@/db";

import {
  billableItems,
  documents,
  encounters,
  labAnalytes,
  labReferenceRanges,
  labReports,
  labResults,
  labResultValues,
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

import type { PrintedContent } from "./document-content";
import type { PatientActor } from "./patients";

import { recordAudit } from "./audit";
import { businessDate, printedAge, printedDateTime } from "./dates";
import { issueDocument, voidDocument } from "./documents";

/**
 * Lab results and the lab report (SCHEMA.md §8, P3 slice 5b).
 *
 * A result is one test's values on one received specimen, each flagged
 * against the reference range and critical limits for the patient's sex and
 * age at collection, and frozen with them (rule 7). Entered results stay in
 * the lab; another lab member verifies one (decided 2026-11-10), or, with one
 * member on night duty, it is released unverified with a reason for the next
 * to verify (decided 2026-11-11). A critical value is not released or
 * verified until who was told, how and when is recorded. A correction is a
 * new version, which supersedes the one before at once.
 *
 * An order's report is issued once every lab test on it is resulted or
 * cancelled, and issued again, the old one voided, whenever what it would
 * say changes. Report work takes an advisory lock on the order, so two
 * changes to one order's results queue; it never touches money (M8 is
 * unaffected).
 */

type ResultRow = typeof labResults.$inferSelect;
type ValueRow = typeof labResultValues.$inferSelect;
export type ResultStatus = ResultRow["status"];
export type Flag = NonNullable<ValueRow["flag"]>;
export type ToldHow = NonNullable<ResultRow["toldHow"]>;

export type LabResultErrorCode
  = | "specimen_not_found"
    | "not_received"
    | "not_on_specimen"
    | "analyte_not_on_test"
    | "value_missing"
    | "value_invalid"
    | "reason_needed"
    | "not_found"
    | "not_pending"
    | "same_person"
    | "told_needed";

export class LabResultError extends Error {
  constructor(readonly code: LabResultErrorCode, detail?: string) {
    super({
      specimen_not_found: "No such specimen",
      not_received: "Results are entered on a specimen the lab has received, and not rejected",
      not_on_specimen: "That test is not on this specimen",
      analyte_not_on_test: "Each value must be for an analyte of this test, in use, once",
      value_missing: `Every number and choice of the test needs a value${detail ? `: ${detail} has none` : ""}`,
      value_invalid: `A number needs a number, a choice one of its answers, and text some text${detail ? `: check ${detail}` : ""}`,
      reason_needed: "This test already has a result; say why it is corrected",
      not_found: "No such result",
      not_pending: "Only a result not yet verified, and not corrected, is released or verified",
      same_person: "Another lab member verifies a result; it cannot be the one who entered it",
      told_needed: "A critical value: record who was told, how and when first",
    }[code]);
    this.name = "LabResultError";
  }
}

export interface Told {
  name: string;
  how: ToldHow;
  /** Now unless given. */
  at?: Date;
}

/** Whole days from `from` to `to`, both Kenyan dates. */
function daysBetween(from: string, to: string): number {
  const utc = (d: string) => {
    const [y, m, day] = d.split("-").map(Number);
    return Date.UTC(y, m - 1, day);
  };
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

interface Judged {
  rangeLow: number | null;
  rangeHigh: number | null;
  flag: Flag | null;
}

function judge(value: number, range: { low: number | null; high: number | null } | undefined, critical: { low: number | null; high: number | null }): Judged {
  const flag: Flag | null
    = critical.low !== null && value < critical.low
      ? "critical_low"
      : critical.high !== null && value > critical.high
        ? "critical_high"
        : range?.low != null && value < range.low
          ? "low"
          : range?.high != null && value > range.high
            ? "high"
            : null;
  return { rangeLow: range?.low ?? null, rangeHigh: range?.high ?? null, flag };
}

/**
 * Enters a test's result on a received specimen, or a corrected version of
 * the one it has, which then supersedes it. Every number and choice of the
 * test needs a value; text is optional.
 */
export async function enterResult(
  tx: AppDb,
  facilityId: string,
  specimenId: string,
  input: { orderItemId: string; values: { analyteId: string; value: number | string }[]; correctionReason?: string },
  actor: PatientActor,
  at = new Date(),
): Promise<ResultRow> {
  const [specimen] = await tx.select().from(specimens).where(eq(specimens.id, specimenId)).for("update").limit(1);
  if (!specimen)
    throw new LabResultError("specimen_not_found");
  if (specimen.status !== "received")
    throw new LabResultError("not_received");
  const [onIt] = await tx
    .select({ labTestId: orderItems.labTestId })
    .from(specimenTests)
    .innerJoin(orderItems, eq(orderItems.id, specimenTests.orderItemId))
    .where(and(eq(specimenTests.specimenId, specimenId), eq(specimenTests.orderItemId, input.orderItemId)))
    .limit(1);
  if (!onIt)
    throw new LabResultError("not_on_specimen");

  // The test as it stood when the specimen was taken: an analyte retired since
  // may still be given, and one added since may be but need not be.
  const analytes = (await tx.select().from(labAnalytes).where(eq(labAnalytes.labTestId, onIt.labTestId!)))
    .filter(a => a.isActive || a.createdAt <= specimen.collectedAt);
  const given = new Map(input.values.map(v => [v.analyteId, v.value]));
  if (given.size !== input.values.length || [...given.keys()].some(id => !analytes.some(a => a.id === id)))
    throw new LabResultError("analyte_not_on_test");
  const missing = analytes.find(a => a.resultType !== "text" && a.isActive && a.createdAt <= specimen.collectedAt && !given.has(a.id));
  if (missing)
    throw new LabResultError("value_missing", missing.code);

  const [patient] = await tx
    .select({ sex: patients.sex, dateOfBirth: patients.dateOfBirth })
    .from(orders)
    .innerJoin(encounters, eq(encounters.id, orders.encounterId))
    .innerJoin(patients, eq(patients.id, encounters.patientId))
    .where(eq(orders.id, specimen.orderId))
    .limit(1);
  const ageDays = daysBetween(patient.dateOfBirth, businessDate(specimen.collectedAt));
  // An intersex patient, or one whose sex is not recorded, is judged against `any` ranges only.
  const sexes = patient.sex === "male" || patient.sex === "female" ? ["any", patient.sex] as const : ["any"] as const;
  const ranges = await tx
    .select()
    .from(labReferenceRanges)
    .where(and(
      inArray(labReferenceRanges.analyteId, analytes.map(a => a.id)),
      isNull(labReferenceRanges.retiredAt),
      inArray(labReferenceRanges.sex, [...sexes]),
      sql`${labReferenceRanges.ageFromDays} <= ${ageDays}`,
      or(isNull(labReferenceRanges.ageToDays), sql`${labReferenceRanges.ageToDays} > ${ageDays}`),
    ));

  const values = analytes.filter(a => given.has(a.id)).map((a) => {
    const value = given.get(a.id)!;
    const base = { facilityId, analyteId: a.id, analyteCode: a.code, analyteName: a.name, resultType: a.resultType };
    if (a.resultType === "numeric") {
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new LabResultError("value_invalid", a.code);
      const judged = judge(value, ranges.find(r => r.analyteId === a.id), { low: a.criticalLow, high: a.criticalHigh });
      return { ...base, unit: a.unit, valueNumeric: value, criticalLow: a.criticalLow, criticalHigh: a.criticalHigh, ...judged };
    }
    const text = typeof value === "string" ? value.trim() : "";
    if (!text || (a.resultType === "choice" && !a.choices!.includes(text)))
      throw new LabResultError("value_invalid", a.code);
    return { ...base, valueText: text, flag: a.resultType === "choice" && a.abnormalChoices!.includes(text) ? "abnormal" as const : null };
  });

  const [previous] = await tx
    .select()
    .from(labResults)
    .where(and(eq(labResults.specimenId, specimenId), eq(labResults.orderItemId, input.orderItemId)))
    .orderBy(desc(labResults.version))
    .for("update")
    .limit(1);
  const current = previous && previous.status !== "superseded" ? previous : null;
  if (current && !input.correctionReason)
    throw new LabResultError("reason_needed");
  if (current)
    await tx.update(labResults).set({ status: "superseded", supersededAt: at }).where(eq(labResults.id, current.id));

  const version = (previous?.version ?? 0) + 1;
  const [result] = await tx.insert(labResults).values({
    facilityId,
    specimenId,
    orderItemId: input.orderItemId,
    version,
    correctionReason: version > 1 ? input.correctionReason ?? "Entered again" : null,
    status: "entered",
    enteredAt: at,
    enteredBy: actor.membershipId,
    hasCritical: values.some(v => v.flag === "critical_low" || v.flag === "critical_high"),
  }).returning();
  await tx.insert(labResultValues).values(values.map(v => ({ ...v, resultId: result.id })));

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "lab_result.entered",
    entityType: "specimen",
    entityId: specimenId,
    summary: `Entered ${version > 1 ? `version ${version} of ` : ""}a result on specimen ${specimen.accessionNumber}`,
    detail: { resultId: result.id, orderItemId: input.orderItemId, version, hasCritical: result.hasCritical, correctionReason: result.correctionReason },
  });
  // A correction takes the result it supersedes off the order's report.
  if (current && current.status !== "entered")
    await refreshReport(tx, facilityId, specimen.orderId, actor, at);
  return result;
}

async function lockPending(tx: AppDb, id: string): Promise<ResultRow> {
  const [result] = await tx.select().from(labResults).where(eq(labResults.id, id)).for("update").limit(1);
  if (!result)
    throw new LabResultError("not_found");
  if (result.status !== "entered" && result.status !== "released")
    throw new LabResultError("not_pending");
  return result;
}

function toldColumns(result: ResultRow, told: Told | undefined, actor: PatientActor, at: Date) {
  if (result.toldName)
    return {};
  if (!told) {
    if (result.hasCritical)
      throw new LabResultError("told_needed");
    return {};
  }
  return { toldName: told.name, toldHow: told.how, toldAt: told.at ?? at, toldRecordedBy: actor.membershipId };
}

async function orderOf(tx: AppDb, result: ResultRow): Promise<{ orderId: string; accessionNumber: string }> {
  const [specimen] = await tx.select({ orderId: specimens.orderId, accessionNumber: specimens.accessionNumber }).from(specimens).where(eq(specimens.id, result.specimenId)).limit(1);
  return specimen;
}

/** Releases a result unverified, for a stated reason (one lab member on duty), for the next to verify. */
export async function releaseResult(tx: AppDb, facilityId: string, id: string, input: { reason: string; told?: Told }, actor: PatientActor, at = new Date()): Promise<ResultRow> {
  const current = await lockPending(tx, id);
  if (current.status !== "entered")
    throw new LabResultError("not_pending");
  const [released] = await tx.update(labResults)
    .set({ status: "released", releasedAt: at, releasedBy: actor.membershipId, releaseReason: input.reason, ...toldColumns(current, input.told, actor, at) })
    .where(eq(labResults.id, id))
    .returning();
  const { orderId, accessionNumber } = await orderOf(tx, released);
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "lab_result.released",
    entityType: "specimen",
    entityId: released.specimenId,
    summary: `Released a result on specimen ${accessionNumber} unverified: ${input.reason}`,
    detail: { resultId: id, reason: input.reason, told: released.toldName !== null },
  });
  await refreshReport(tx, facilityId, orderId, actor, at);
  return released;
}

/** Verifies a result, by a lab member other than the one who entered it. */
export async function verifyResult(tx: AppDb, facilityId: string, id: string, input: { told?: Told }, actor: PatientActor, at = new Date()): Promise<ResultRow> {
  const current = await lockPending(tx, id);
  if (current.enteredBy === actor.membershipId)
    throw new LabResultError("same_person");
  const [verified] = await tx.update(labResults)
    .set({ status: "verified", verifiedAt: at, verifiedBy: actor.membershipId, ...toldColumns(current, input.told, actor, at) })
    .where(eq(labResults.id, id))
    .returning();
  const { orderId, accessionNumber } = await orderOf(tx, verified);
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "lab_result.verified",
    entityType: "specimen",
    entityId: verified.specimenId,
    summary: `Verified a result on specimen ${accessionNumber}`,
    detail: { resultId: id, told: verified.toldName !== null },
  });
  await refreshReport(tx, facilityId, orderId, actor, at);
  return verified;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ShownValue {
  analyteId: string;
  code: string;
  name: string;
  resultType: ValueRow["resultType"];
  /** A number, or a choice's answer or text. */
  value: number | string;
  unit: string | null;
  range: { low: number | null; high: number | null } | null;
  flag: Flag | null;
}

export interface ShownResult {
  id: string;
  orderId: string;
  orderItemId: string;
  specimenId: string;
  accessionNumber: string;
  /** The test's code and name. */
  code: string;
  name: string;
  version: number;
  correctionReason: string | null;
  status: ResultStatus;
  enteredAt: Date;
  enteredBy: { membershipId: string; name: string };
  releasedAt: Date | null;
  releaseReason: string | null;
  verifiedAt: Date | null;
  verifiedBy: { membershipId: string; name: string } | null;
  hasCritical: boolean;
  told: { name: string; how: ToldHow; at: Date } | null;
  values: ShownValue[];
}

/** Current results matching `where`, urgent first, then by entry, each with its values in report order. */
export async function resultsWhere(tx: AppDb, where: SQL | undefined): Promise<ShownResult[]> {
  const enterer = alias(user, "enterer");
  const verifier = alias(user, "verifier");
  const enteringMembership = alias(memberships, "entering_membership");
  const verifyingMembership = alias(memberships, "verifying_membership");
  const rows = await tx
    .select({
      result: labResults,
      orderId: specimens.orderId,
      accessionNumber: specimens.accessionNumber,
      code: billableItems.code,
      name: billableItems.name,
      enteredByName: enterer.name,
      verifiedByName: verifier.name,
    })
    .from(labResults)
    .innerJoin(specimens, eq(specimens.id, labResults.specimenId))
    .innerJoin(orders, eq(orders.id, specimens.orderId))
    .innerJoin(orderItems, eq(orderItems.id, labResults.orderItemId))
    .innerJoin(labTests, eq(labTests.id, orderItems.labTestId))
    .innerJoin(billableItems, eq(billableItems.id, labTests.billableItemId))
    .innerJoin(enteringMembership, eq(enteringMembership.id, labResults.enteredBy))
    .innerJoin(enterer, eq(enterer.id, enteringMembership.userId))
    .leftJoin(verifyingMembership, eq(verifyingMembership.id, labResults.verifiedBy))
    .leftJoin(verifier, eq(verifier.id, verifyingMembership.userId))
    .where(and(ne(labResults.status, "superseded"), where))
    // Urgent first, before the limit, so a late urgent result is never cut off.
    .orderBy(asc(sql`CASE ${orders.urgency} WHEN 'urgent' THEN 0 ELSE 1 END`), asc(labResults.enteredAt), asc(billableItems.code))
    .limit(500);
  if (rows.length === 0)
    return [];

  const values = await tx
    .select({ value: labResultValues, position: labAnalytes.position })
    .from(labResultValues)
    .innerJoin(labAnalytes, eq(labAnalytes.id, labResultValues.analyteId))
    .where(inArray(labResultValues.resultId, rows.map(r => r.result.id)))
    .orderBy(asc(labAnalytes.position));

  return rows.map(({ result: r, ...row }) => ({
    id: r.id,
    orderId: row.orderId,
    orderItemId: r.orderItemId,
    specimenId: r.specimenId,
    accessionNumber: row.accessionNumber,
    code: row.code,
    name: row.name,
    version: r.version,
    correctionReason: r.correctionReason,
    status: r.status,
    enteredAt: r.enteredAt,
    enteredBy: { membershipId: r.enteredBy, name: row.enteredByName },
    releasedAt: r.releasedAt,
    releaseReason: r.releaseReason,
    verifiedAt: r.verifiedAt,
    verifiedBy: r.verifiedBy ? { membershipId: r.verifiedBy, name: row.verifiedByName! } : null,
    hasCritical: r.hasCritical,
    told: r.toldName ? { name: r.toldName, how: r.toldHow!, at: r.toldAt! } : null,
    values: values.filter(v => v.value.resultId === r.id).map(({ value: v }) => ({
      analyteId: v.analyteId,
      code: v.analyteCode,
      name: v.analyteName,
      resultType: v.resultType,
      value: v.resultType === "numeric" ? v.valueNumeric! : v.valueText!,
      unit: v.unit,
      range: v.rangeLow === null && v.rangeHigh === null ? null : { low: v.rangeLow, high: v.rangeHigh },
      flag: v.flag,
    })),
  }));
}

/** One result as the lab sees it. */
export async function resultShown(tx: AppDb, id: string): Promise<ShownResult> {
  const [shown] = await resultsWhere(tx, eq(labResults.id, id));
  if (!shown)
    throw new LabResultError("not_found");
  return shown;
}

/** Results waiting for verification, entered or released unverified: the lab's to verify. */
export async function pendingResults(tx: AppDb): Promise<ShownResult[]> {
  return resultsWhere(tx, inArray(labResults.status, ["entered", "released"]));
}

export interface EncounterResults {
  /** Released and verified results: what reaches the clinician. */
  results: ShownResult[];
  /** Each order's current printed report. */
  reports: { orderId: string; documentId: string; number: string }[];
}

/** An encounter's results as clinicians see them, and its reports. Audited (rule 9). */
export async function listResults(tx: AppDb, facilityId: string, encounterId: string, actor: PatientActor): Promise<EncounterResults | null> {
  const [encounter] = await tx.select({ id: encounters.id }).from(encounters).where(eq(encounters.id, encounterId)).limit(1);
  if (!encounter)
    return null;
  const orderIds = (await tx.select({ id: orders.id }).from(orders).where(eq(orders.encounterId, encounterId))).map(o => o.id);
  const results = orderIds.length === 0
    ? []
    : await resultsWhere(tx, and(inArray(specimens.orderId, orderIds), inArray(labResults.status, ["released", "verified"])));
  const reports = orderIds.length === 0
    ? []
    : await tx
        .select({ orderId: labReports.orderId, documentId: documents.id, number: documents.number })
        .from(labReports)
        .innerJoin(documents, and(eq(documents.id, labReports.documentId), isNull(documents.voidedAt)))
        .where(inArray(labReports.orderId, orderIds))
        .orderBy(asc(documents.issuedAt));

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "encounter.viewed",
    entityType: "encounter",
    entityId: encounterId,
    summary: `Viewed lab results (${results.length})`,
  });
  return { results, reports };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const FLAGS: Record<Flag, string> = { low: "L", high: "H", critical_low: "LL (critical)", critical_high: "HH (critical)", abnormal: "Abnormal" };

function printedNumber(n: number): string {
  return String(Number(n.toFixed(6)));
}

function printedRange(range: ShownValue["range"]): string {
  if (!range)
    return "";
  if (range.low !== null && range.high !== null)
    return `${printedNumber(range.low)}–${printedNumber(range.high)}`;
  return range.low !== null ? `≥ ${printedNumber(range.low)}` : `≤ ${printedNumber(range.high!)}`;
}

async function printedReport(tx: AppDb, orderId: string, results: ShownResult[], cancelled: { code: string; name: string; reason: string }[]): Promise<PrintedContent> {
  const [order] = await tx
    .select({
      order: orders,
      givenName: patients.givenName,
      middleNames: patients.middleNames,
      familyName: patients.familyName,
      sex: patients.sex,
      dateOfBirth: patients.dateOfBirth,
      opNumber: patientNumbers.number,
      ordererName: user.name,
    })
    .from(orders)
    .innerJoin(encounters, eq(encounters.id, orders.encounterId))
    .innerJoin(patients, eq(patients.id, encounters.patientId))
    .leftJoin(patientNumbers, and(eq(patientNumbers.patientId, patients.id), eq(patientNumbers.kind, "outpatient")))
    .leftJoin(memberships, eq(memberships.id, orders.orderedBy))
    .leftJoin(user, eq(user.id, memberships.userId))
    .where(eq(orders.id, orderId))
    .limit(1);
  const o = order.order;
  const requestedBy = o.orderedBy
    ? order.ordererName!
    : o.requesterName
      ? `${o.requesterName}, ${o.requesterFacility}${o.requesterLicence ? ` (licence ${o.requesterLicence})` : ""}`
      : "Self-requested";
  const taken = await tx
    .select({ accessionNumber: specimens.accessionNumber, specimenType: specimens.specimenType, collectedAt: specimens.collectedAt })
    .from(specimens)
    .where(and(eq(specimens.orderId, orderId), ne(specimens.status, "rejected")))
    .orderBy(asc(specimens.accessionNumber));
  const today = businessDate();
  const sex = order.sex ? `${order.sex[0].toUpperCase()}${order.sex.slice(1)}, ` : "";

  const unverified = results.filter(r => r.status === "released");
  const notes = [
    ...(unverified.length > 0
      ? [`Released unverified, to be verified: ${unverified.map(r => `${r.code} (${r.releaseReason})`).join("; ")}.`]
      : []),
    ...(results.some(r => r.verifiedBy)
      ? [`Verified: ${results.filter(r => r.verifiedBy).map(r => `${r.code} by ${r.verifiedBy!.name}`).join("; ")}.`]
      : []),
    ...(results.some(r => r.told)
      ? [`Critical values reported: ${results.filter(r => r.told).map(r => `${r.code} to ${r.told!.name} (${r.told!.how === "phone" ? "by phone" : "in person"}, ${printedDateTime(r.told!.at)})`).join("; ")}.`]
      : []),
    ...(results.some(r => r.version > 1)
      ? [`Corrected: ${results.filter(r => r.version > 1).map(r => `${r.code} (${r.correctionReason})`).join("; ")}.`]
      : []),
  ].map(n => n.slice(0, 1000));

  return {
    title: "Laboratory report",
    fields: [
      { label: "Patient", value: [order.givenName, order.middleNames, order.familyName].filter(Boolean).join(" ") },
      { label: "Patient number", value: order.opNumber ?? "" },
      { label: "Sex and age", value: `${sex}${printedAge(order.dateOfBirth, today)}` },
      { label: "Requested by", value: requestedBy.slice(0, 500) },
      { label: "Requested", value: printedDateTime(o.orderedAt) },
      { label: "Specimens", value: taken.map(t => `${t.accessionNumber} (${t.specimenType.replaceAll("_", " ")}, ${printedDateTime(t.collectedAt)})`).join("; ").slice(0, 500) },
    ],
    table: {
      columns: [
        { label: "Test" },
        { label: "Analyte" },
        { label: "Result", align: "right" },
        { label: "Unit" },
        { label: "Reference range" },
        { label: "Flag" },
      ],
      rows: [
        ...results.flatMap(r => r.values.map((v, i) => [
          i === 0 ? `${r.name}${r.status === "released" ? " (unverified)" : ""}` : "",
          v.name,
          typeof v.value === "number" ? printedNumber(v.value) : v.value.slice(0, 500),
          v.unit ?? "",
          printedRange(v.range),
          v.flag ? FLAGS[v.flag] : "",
        ])),
        ...cancelled.map(c => [c.name, "", "Not done", "", "", `Cancelled: ${c.reason}`.slice(0, 500)]),
      ],
    },
    notes,
  };
}

/**
 * Brings an order's report up to date after its results change: the
 * current one is voided, and a new one issued if every lab test on the order
 * is now resulted (released or verified) or cancelled.
 */
export async function refreshReport(tx: AppDb, facilityId: string, orderId: string, actor: PatientActor, at = new Date()): Promise<void> {
  // Serializes report work for one order: an order row takes no lock (it is
  // written once, so the app role cannot lock it), hence a transaction-scoped
  // advisory lock, released when the transaction ends.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`lab_report:${orderId}`}, 0))`);

  const live = await tx
    .select({ documentId: documents.id })
    .from(labReports)
    .innerJoin(documents, and(eq(documents.id, labReports.documentId), isNull(documents.voidedAt)))
    .where(eq(labReports.orderId, orderId));
  for (const { documentId } of live)
    await voidDocument(tx, { facilityId, documentId, reason: "A result on it changed; a new report replaces it", voidedBy: actor, at });

  const items = await tx
    .select({ id: orderItems.id, status: orderItems.status, reason: orderItems.cancellationReason, code: billableItems.code, name: billableItems.name })
    .from(orderItems)
    .innerJoin(labTests, eq(labTests.id, orderItems.labTestId))
    .innerJoin(billableItems, eq(billableItems.id, labTests.billableItemId))
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(billableItems.code));
  if (items.length === 0)
    return;
  const results = await resultsWhere(tx, and(eq(specimens.orderId, orderId), inArray(labResults.status, ["released", "verified"])));
  const resulted = new Set(results.map(r => r.orderItemId));
  if (!items.every(i => i.status === "cancelled" || resulted.has(i.id)))
    return;

  const cancelled = items.filter(i => i.status === "cancelled").map(i => ({ code: i.code, name: i.name, reason: i.reason! }));
  if (results.length === 0)
    return;
  results.sort((a, b) => a.code.localeCompare(b.code));
  const document = await issueDocument(tx, {
    facilityId,
    kind: "lab_report",
    content: await printedReport(tx, orderId, results, cancelled),
    issuedBy: actor,
    at,
  });
  await tx.insert(labReports).values({ facilityId, orderId, documentId: document.id });

  const [order] = await tx.select({ encounterId: orders.encounterId }).from(orders).where(eq(orders.id, orderId)).limit(1);
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "lab_report.issued",
    entityType: "encounter",
    entityId: order.encounterId,
    summary: `Issued lab report ${document.number}`,
    detail: { orderId, number: document.number, results: results.map(r => r.id), replaced: live.length > 0 },
  });
}

/** Whether a specimen has a current result. */
export async function hasResults(tx: AppDb, specimenId: string): Promise<boolean> {
  const [row] = await tx.select({ id: labResults.id }).from(labResults).where(and(eq(labResults.specimenId, specimenId), ne(labResults.status, "superseded"))).limit(1);
  return Boolean(row);
}
