import { and, asc, count, eq, inArray, isNull, max, ne, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { billableItems, labAnalytes, labReferenceRanges, labTests } from "@/db/schema";

import type { PatientActor } from "./patients";

import { recordAudit } from "./audit";
import { isExclusionViolation, isUniqueViolation } from "./db-errors";

/**
 * The lab's catalogue (SCHEMA.md §8, P3 slice 4a): each test the facility's
 * lab does, the analytes it reports, and each numeric analyte's reference
 * ranges and critical limits. Kept by the facility admin and the lab
 * supervisor; nothing is shipped (decided 2026-11-11), so no range here was
 * made up for the facility.
 *
 * A test is a `lab` billable item with lab details: its code, name and
 * price are the item's, so the bill and the lab never disagree.
 */

type LabTestRow = typeof labTests.$inferSelect;
type AnalyteRow = typeof labAnalytes.$inferSelect;
type RangeRow = typeof labReferenceRanges.$inferSelect;
export type SpecimenType = LabTestRow["specimenType"];
export type ResultType = AnalyteRow["resultType"];
export type RangeSex = RangeRow["sex"];

/**
 * The most analytes a test has, so an order's report (at most 30 tests) fits
 * the rows a printed document holds (`document-content.ts`).
 */
export const MAX_ANALYTES = 60;

export type LabCatalogueErrorCode
  = | "not_found"
    | "analyte_not_found"
    | "not_a_lab_item"
    | "already_a_test"
    | "code_taken"
    | "not_numeric"
    | "not_a_choice"
    | "abnormal_not_a_choice"
    | "critical_limits_invalid"
    | "ranges_overlap"
    | "too_many_analytes"
    | "last_analyte"
    | "no_analytes"
    | "answer_in_use";

export class LabCatalogueError extends Error {
  constructor(readonly code: LabCatalogueErrorCode) {
    super({
      not_found: "No such lab test",
      analyte_not_found: "No such analyte",
      not_a_lab_item: "That item is not an active lab item",
      already_a_test: "That item is already a lab test",
      code_taken: "That test already has an analyte with this code",
      not_numeric: "Only a numeric analyte has a unit, critical limits or reference ranges",
      not_a_choice: "Only a choice analyte has answers",
      abnormal_not_a_choice: "Each abnormal answer must be one of the analyte's answers",
      critical_limits_invalid: "The critical low must be below the critical high",
      ranges_overlap: "Two of these ranges cover the same patients; each sex and age may have one range",
      too_many_analytes: `A test has at most ${MAX_ANALYTES} analytes`,
      last_analyte: "This is the test's last analyte in use; retire the test first, or add another analyte",
      no_analytes: "This test has no analyte in use, so it could never be resulted; bring one back or add one first",
      answer_in_use: "A specimen still waiting for its result may be given this answer; remove it once those specimens are resulted",
    }[code]);
    this.name = "LabCatalogueError";
  }
}

export interface RangeInput {
  sex: RangeSex;
  ageFromDays: number;
  ageToDays: number | null;
  low: number | null;
  high: number | null;
}

/** An analyte as it is set up. Which fields apply follows from its result type. */
export type AnalyteInput
  = | { code: string; name: string; resultType: "numeric"; unit?: string | null; criticalLow?: number | null; criticalHigh?: number | null; ranges?: RangeInput[] }
    | { code: string; name: string; resultType: "choice"; choices: string[]; abnormalChoices?: string[] }
    | { code: string; name: string; resultType: "text" };

function analyteValues(facilityId: string, labTestId: string, position: number, input: AnalyteInput) {
  const base = { facilityId, labTestId, position, code: input.code, name: input.name, resultType: input.resultType };
  if (input.resultType === "numeric")
    return { ...base, unit: input.unit ?? null, criticalLow: input.criticalLow ?? null, criticalHigh: input.criticalHigh ?? null };
  if (input.resultType === "choice")
    return { ...base, choices: input.choices, abnormalChoices: input.abnormalChoices ?? [] };
  return base;
}

async function insertRanges(tx: AppDb, facilityId: string, analyteId: string, ranges: RangeInput[]): Promise<void> {
  if (ranges.length === 0)
    return;
  try {
    await tx.insert(labReferenceRanges).values(ranges.map(r => ({ facilityId, analyteId, ...r })));
  }
  catch (err) {
    if (isExclusionViolation(err))
      throw new LabCatalogueError("ranges_overlap");
    throw err;
  }
}

async function insertAnalyte(tx: AppDb, facilityId: string, labTestId: string, position: number, input: AnalyteInput): Promise<AnalyteRow> {
  let analyte: AnalyteRow;
  try {
    [analyte] = await tx.insert(labAnalytes).values(analyteValues(facilityId, labTestId, position, input)).returning();
  }
  catch (err) {
    if (isUniqueViolation(err))
      throw new LabCatalogueError("code_taken");
    throw err;
  }
  if (input.resultType === "numeric")
    await insertRanges(tx, facilityId, analyte.id, input.ranges ?? []);
  return analyte;
}

/** Sets up a test on an active `lab` item, with its analytes in report order. */
export async function createLabTest(
  tx: AppDb,
  facilityId: string,
  input: { billableItemId: string; specimenType: SpecimenType; analytes: AnalyteInput[] },
  actor: PatientActor,
): Promise<LabTestRow> {
  const [item] = await tx.select().from(billableItems).where(eq(billableItems.id, input.billableItemId)).limit(1);
  if (!item || item.category !== "lab" || !item.isActive)
    throw new LabCatalogueError("not_a_lab_item");

  let test: LabTestRow;
  try {
    [test] = await tx.insert(labTests).values({ facilityId, billableItemId: item.id, specimenType: input.specimenType }).returning();
  }
  catch (err) {
    if (isUniqueViolation(err))
      throw new LabCatalogueError("already_a_test");
    throw err;
  }
  for (const [position, analyte] of input.analytes.entries())
    await insertAnalyte(tx, facilityId, test.id, position, analyte);

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "lab_test.created",
    entityType: "lab_test",
    entityId: test.id,
    summary: `Set up lab test ${item.code} ${item.name}`,
    detail: { code: item.code, specimenType: test.specimenType, analytes: input.analytes.map(a => a.code) },
  });
  return test;
}

/** Changes a test's specimen, or retires it from ordering or brings it back. */
export async function updateLabTest(
  tx: AppDb,
  facilityId: string,
  id: string,
  input: { specimenType?: SpecimenType; isActive?: boolean },
  actor: PatientActor,
): Promise<LabTestRow> {
  const [current] = await tx.select().from(labTests).where(eq(labTests.id, id)).for("update").limit(1);
  if (!current)
    throw new LabCatalogueError("not_found");
  // Offered for ordering only with something to result (the lock on the test serializes this with retiring analytes).
  if (input.isActive && !current.isActive && await activeAnalytes(tx, id) === 0)
    throw new LabCatalogueError("no_analytes");
  const [test] = await tx.update(labTests).set(input).where(eq(labTests.id, id)).returning();

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "lab_test.updated",
    entityType: "lab_test",
    entityId: id,
    summary: "Updated a lab test",
    detail: {
      before: { specimenType: current.specimenType, isActive: current.isActive },
      after: { specimenType: test.specimenType, isActive: test.isActive },
    },
  });
  return test;
}

/** Adds an analyte to a test, last in its report. */
export async function addAnalyte(tx: AppDb, facilityId: string, labTestId: string, input: AnalyteInput, actor: PatientActor): Promise<AnalyteRow> {
  // Locked, so two analytes added at once take different places.
  const [test] = await tx.select({ id: labTests.id }).from(labTests).where(eq(labTests.id, labTestId)).for("update").limit(1);
  if (!test)
    throw new LabCatalogueError("not_found");
  const [{ last, n }] = await tx.select({ last: max(labAnalytes.position), n: count() }).from(labAnalytes).where(eq(labAnalytes.labTestId, labTestId));
  if (n >= MAX_ANALYTES)
    throw new LabCatalogueError("too_many_analytes");
  const analyte = await insertAnalyte(tx, facilityId, labTestId, last === null ? 0 : last + 1, input);

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "lab_analyte.added",
    entityType: "lab_test",
    entityId: labTestId,
    summary: `Added analyte ${analyte.code} to a lab test`,
    detail: { analyteId: analyte.id, code: analyte.code, resultType: analyte.resultType },
  });
  return analyte;
}

export interface AnalyteChange {
  name?: string;
  unit?: string | null;
  criticalLow?: number | null;
  criticalHigh?: number | null;
  choices?: string[];
  abnormalChoices?: string[];
  isActive?: boolean;
}

async function activeAnalytes(tx: AppDb, labTestId: string, except?: string): Promise<number> {
  const [{ n }] = await tx
    .select({ n: count() })
    .from(labAnalytes)
    .where(and(eq(labAnalytes.labTestId, labTestId), eq(labAnalytes.isActive, true), except ? ne(labAnalytes.id, except) : undefined));
  return n;
}

/**
 * Refuses retiring an offered test's last analyte in use: the test would be
 * ordered and charged, but never collected (lib/specimens.ts). The test is
 * locked, so two analytes retired at once cannot both pass for the other.
 */
async function keepsAnAnalyte(tx: AppDb, analyte: AnalyteRow): Promise<void> {
  const [test] = await tx.select({ isActive: labTests.isActive }).from(labTests).where(eq(labTests.id, analyte.labTestId)).for("update").limit(1);
  if (test.isActive && await activeAnalytes(tx, analyte.labTestId, analyte.id) === 0)
    throw new LabCatalogueError("last_analyte");
}

/** Whether a specimen taken with this analyte in its panel still waits for its test's result. */
async function awaitedOnASpecimen(tx: AppDb, analyteId: string): Promise<boolean> {
  const { rows } = await tx.execute(sql`
    SELECT 1 FROM specimen_tests st
      JOIN specimens s ON s.facility_id = st.facility_id AND s.id = st.specimen_id
    WHERE ${analyteId}::uuid = ANY(st.analyte_ids) AND s.status <> 'rejected'
      AND NOT EXISTS (SELECT 1 FROM lab_results r
        WHERE r.specimen_id = st.specimen_id AND r.order_item_id = st.order_item_id AND r.status <> 'superseded')
    LIMIT 1`);
  return rows.length > 0;
}

/** Edits an analyte's wording, unit, answers or critical limits, or retires it. Its result type never changes. */
export async function updateAnalyte(tx: AppDb, facilityId: string, id: string, input: AnalyteChange, actor: PatientActor): Promise<AnalyteRow> {
  const [current] = await tx.select().from(labAnalytes).where(eq(labAnalytes.id, id)).for("update").limit(1);
  if (!current)
    throw new LabCatalogueError("analyte_not_found");
  const numericOnly = input.unit !== undefined || input.criticalLow !== undefined || input.criticalHigh !== undefined;
  if (numericOnly && current.resultType !== "numeric")
    throw new LabCatalogueError("not_numeric");
  if ((input.choices !== undefined || input.abnormalChoices !== undefined) && current.resultType !== "choice")
    throw new LabCatalogueError("not_a_choice");
  // What the row will hold, checked here so the refusal says why rather than failing the CHECK.
  const choices = input.choices ?? current.choices ?? [];
  if (!(input.abnormalChoices ?? current.abnormalChoices ?? []).every(a => choices.includes(a)))
    throw new LabCatalogueError("abnormal_not_a_choice");
  const low = input.criticalLow === undefined ? current.criticalLow : input.criticalLow;
  const high = input.criticalHigh === undefined ? current.criticalHigh : input.criticalHigh;
  if (low !== null && high !== null && low >= high)
    throw new LabCatalogueError("critical_limits_invalid");
  if (input.isActive === false && current.isActive)
    await keepsAnAnalyte(tx, current);
  if (input.choices && (current.choices ?? []).some(c => !input.choices!.includes(c)) && await awaitedOnASpecimen(tx, id))
    throw new LabCatalogueError("answer_in_use");

  const [analyte] = await tx.update(labAnalytes).set(input).where(eq(labAnalytes.id, id)).returning();
  const shown = (a: AnalyteRow) => ({
    name: a.name,
    unit: a.unit,
    criticalLow: a.criticalLow,
    criticalHigh: a.criticalHigh,
    choices: a.choices,
    abnormalChoices: a.abnormalChoices,
    isActive: a.isActive,
  });
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "lab_analyte.updated",
    entityType: "lab_test",
    entityId: current.labTestId,
    summary: `Updated analyte ${current.code}`,
    detail: { analyteId: id, before: shown(current), after: shown(analyte) },
  });
  return analyte;
}

/**
 * Replaces a numeric analyte's reference ranges with `ranges`: the current
 * ones are retired, never edited, so a result keeps the range it was judged
 * by. An empty list leaves it with none.
 */
export async function setReferenceRanges(tx: AppDb, facilityId: string, analyteId: string, ranges: RangeInput[], actor: PatientActor): Promise<AnalyteRow> {
  const [analyte] = await tx.select().from(labAnalytes).where(eq(labAnalytes.id, analyteId)).for("update").limit(1);
  if (!analyte)
    throw new LabCatalogueError("analyte_not_found");
  if (analyte.resultType !== "numeric")
    throw new LabCatalogueError("not_numeric");

  const retired = await tx.update(labReferenceRanges)
    .set({ retiredAt: new Date() })
    .where(and(eq(labReferenceRanges.analyteId, analyteId), isNull(labReferenceRanges.retiredAt)))
    .returning();
  await insertRanges(tx, facilityId, analyteId, ranges);

  const shown = (r: RangeInput) => ({ sex: r.sex, ageFromDays: r.ageFromDays, ageToDays: r.ageToDays, low: r.low, high: r.high });
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "lab_analyte.ranges_set",
    entityType: "lab_test",
    entityId: analyte.labTestId,
    summary: `Set ${ranges.length} reference range(s) for analyte ${analyte.code}`,
    detail: { analyteId, before: retired.map(shown), after: ranges.map(shown) },
  });
  return analyte;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type ShownRange = RangeInput;

export interface ShownAnalyte {
  id: string;
  code: string;
  name: string;
  resultType: ResultType;
  unit: string | null;
  choices: string[] | null;
  abnormalChoices: string[] | null;
  criticalLow: number | null;
  criticalHigh: number | null;
  isActive: boolean;
  /** Current ranges only. */
  ranges: ShownRange[];
}

export interface ShownLabTest {
  id: string;
  billableItemId: string;
  /** The item's code and name. */
  code: string;
  name: string;
  specimenType: SpecimenType;
  isActive: boolean;
  /** In report order. */
  analytes: ShownAnalyte[];
}

/** The catalogue, by code, each test with its analytes and their current ranges. Not patient data, so not audited. */
export async function listLabTests(tx: AppDb, filter: { id?: string } = {}): Promise<ShownLabTest[]> {
  const tests = await tx
    .select({ test: labTests, code: billableItems.code, name: billableItems.name })
    .from(labTests)
    .innerJoin(billableItems, eq(billableItems.id, labTests.billableItemId))
    .where(filter.id ? eq(labTests.id, filter.id) : undefined)
    .orderBy(asc(billableItems.code));
  if (tests.length === 0)
    return [];

  const analytes = await tx
    .select()
    .from(labAnalytes)
    .where(inArray(labAnalytes.labTestId, tests.map(t => t.test.id)))
    .orderBy(asc(labAnalytes.position));
  const ranges = analytes.length === 0
    ? []
    : await tx
        .select()
        .from(labReferenceRanges)
        .where(and(inArray(labReferenceRanges.analyteId, analytes.map(a => a.id)), isNull(labReferenceRanges.retiredAt)))
        .orderBy(asc(labReferenceRanges.sex), asc(labReferenceRanges.ageFromDays));

  const analytesOf = Map.groupBy(analytes, a => a.labTestId);
  const rangesOf = Map.groupBy(ranges, r => r.analyteId);
  return tests.map(({ test, code, name }) => ({
    id: test.id,
    billableItemId: test.billableItemId,
    code,
    name,
    specimenType: test.specimenType,
    isActive: test.isActive,
    analytes: (analytesOf.get(test.id) ?? []).map(a => ({
      id: a.id,
      code: a.code,
      name: a.name,
      resultType: a.resultType,
      unit: a.unit,
      choices: a.choices,
      abnormalChoices: a.abnormalChoices,
      criticalLow: a.criticalLow,
      criticalHigh: a.criticalHigh,
      isActive: a.isActive,
      ranges: (rangesOf.get(a.id) ?? []).map(r => ({ sex: r.sex, ageFromDays: r.ageFromDays, ageToDays: r.ageToDays, low: r.low, high: r.high })),
    })),
  }));
}

/** One test as the catalogue shows it. */
export async function labTestShown(tx: AppDb, id: string): Promise<ShownLabTest> {
  const [test] = await listLabTests(tx, { id });
  if (!test)
    throw new LabCatalogueError("not_found");
  return test;
}
