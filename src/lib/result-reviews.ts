import { and, asc, desc, eq, inArray, isNotNull, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { AppDb } from "@/db";

import {
  billableItems,
  encounters,
  labResultReviews,
  labResults,
  labResultValues,
  labTests,
  memberships,
  orderItems,
  orders,
  patientNumbers,
  patients,
  specimens,
  user,
} from "@/db/schema";

import type { PatientActor } from "./patients";
import type { SensitiveCategory } from "./sensitivity";

import { recordAudit } from "./audit";
import { isUniqueViolation } from "./db-errors";
import { isRestricted, orderGuards, sight } from "./sensitivity";

/**
 * The results-to-review list (decided 2026-11-17, ROADMAP.md P3): each
 * clinician's results not yet marked reviewed, so none is missed, whether
 * the patient came back for it or had gone home. A walk-in's results are
 * the outside requester's, on the printed report, and are not listed.
 */

/** The most one read lists: `offset` shows the next. */
export const REVIEW_PAGE = 100;

export type ReviewErrorCode = "not_found" | "not_reviewable" | "already_reviewed";

export class ReviewError extends Error {
  constructor(readonly code: ReviewErrorCode) {
    super({
      not_found: "No such result",
      not_reviewable: "Only a result the lab has released or verified is reviewed",
      already_reviewed: "This result has been reviewed already",
    }[code]);
    this.name = "ReviewError";
  }
}

export interface ToReview {
  resultId: string;
  status: "released" | "verified";
  hasCritical: boolean;
  /** Any value outside its range, or a choice marked abnormal. */
  abnormal: boolean;
  /** When the lab released or verified it, whichever came first. */
  resultedAt: Date;
  test: { code: string; name: string };
  patient: { id: string; name: string; opNumber: string | null };
  encounterId: string;
  visitOpen: boolean;
  orderedBy: { membershipId: string; name: string };
}

const orderer = alias(memberships, "orderer");
const ordererUser = alias(user, "orderer_user");

const abnormal = sql<boolean>`EXISTS (SELECT 1 FROM ${labResultValues} v WHERE v.result_id = ${labResults.id} AND v.flag IS NOT NULL)`;
const resultedAt = sql<Date>`coalesce(${labResults.releasedAt}, ${labResults.verifiedAt})`;

/** A page of results to review, critical first, then abnormal, then the longest waiting. */
function unreviewed(tx: AppDb, mine: string | null, offset: number) {
  return tx
    .select({
      resultId: labResults.id,
      status: labResults.status,
      hasCritical: labResults.hasCritical,
      abnormal,
      resultedAt,
      enteredBy: labResults.enteredBy,
      verifiedBy: labResults.verifiedBy,
      code: billableItems.code,
      name: billableItems.name,
      orderId: orders.id,
      orderedBy: orders.orderedBy,
      ordererName: ordererUser.name,
      encounterId: encounters.id,
      encounterStatus: encounters.status,
      patientId: patients.id,
      givenName: patients.givenName,
      middleNames: patients.middleNames,
      familyName: patients.familyName,
      opNumber: patientNumbers.number,
    })
    .from(labResults)
    .innerJoin(specimens, eq(specimens.id, labResults.specimenId))
    .innerJoin(orders, eq(orders.id, specimens.orderId))
    .innerJoin(orderItems, eq(orderItems.id, labResults.orderItemId))
    .innerJoin(labTests, eq(labTests.id, orderItems.labTestId))
    .innerJoin(billableItems, eq(billableItems.id, labTests.billableItemId))
    .innerJoin(encounters, eq(encounters.id, orders.encounterId))
    .innerJoin(patients, eq(patients.id, encounters.patientId))
    .leftJoin(patientNumbers, and(eq(patientNumbers.patientId, patients.id), eq(patientNumbers.kind, "outpatient")))
    .innerJoin(orderer, eq(orderer.id, orders.orderedBy))
    .innerJoin(ordererUser, eq(ordererUser.id, orderer.userId))
    .where(and(
      inArray(labResults.status, ["released", "verified"]),
      isNotNull(orders.orderedBy),
      mine ? eq(orders.orderedBy, mine) : undefined,
      notExists(tx.select({ id: labResultReviews.id }).from(labResultReviews).where(eq(labResultReviews.labResultId, labResults.id))),
    ))
    .orderBy(desc(labResults.hasCritical), desc(abnormal), asc(resultedAt), asc(labResults.id))
    .limit(REVIEW_PAGE)
    .offset(offset);
}

/**
 * The results to review: the reader's own orders (`mine`), or every
 * clinician's (`all`), so none waits on someone off duty. A result the
 * reader may not see (a sensitive test, rule 27) is left off and counted.
 * Audited with the patients it names (rule 9).
 */
export async function resultsToReview(
  tx: AppDb,
  facilityId: string,
  input: { scope: "mine" | "all"; offset?: number },
  actor: PatientActor,
): Promise<{ results: ToReview[]; restricted: number }> {
  const rows = await unreviewed(tx, input.scope === "mine" ? actor.membershipId : null, input.offset ?? 0);
  const [member] = await tx.select({ categories: memberships.sensitiveCategories }).from(memberships).where(eq(memberships.id, actor.membershipId)).limit(1);
  // Across many patients, so no one patient's break-glass grant opens anything here.
  const reader = { membershipId: actor.membershipId, categories: new Set<SensitiveCategory>(member?.categories ?? []), grantId: null };
  const guards = await orderGuards(tx, [...new Set(rows.map(r => r.orderId))]);
  const seen = rows.filter((r) => {
    const order = guards.get(r.orderId)!;
    return sight(reader, { categories: order.categories, recordedBy: [...order.recordedBy, r.enteredBy, r.verifiedBy] }) === "open";
  });

  const results = seen.map((r): ToReview => ({
    resultId: r.resultId,
    status: r.status as ToReview["status"],
    hasCritical: r.hasCritical,
    abnormal: r.abnormal,
    resultedAt: new Date(r.resultedAt),
    test: { code: r.code, name: r.name },
    patient: { id: r.patientId, name: [r.givenName, r.middleNames, r.familyName].filter(Boolean).join(" "), opNumber: r.opNumber },
    encounterId: r.encounterId,
    visitOpen: r.encounterStatus === "open",
    orderedBy: { membershipId: r.orderedBy!, name: r.ordererName },
  }));
  const restricted = rows.length - seen.length;
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "lab_result.review_list_viewed",
    entityType: "membership",
    entityId: actor.membershipId,
    summary: `Viewed results to review (${results.length})`,
    detail: { scope: input.scope, patients: [...new Set(results.map(r => r.patient.id))], ...(restricted > 0 ? { restricted } : {}) },
  });
  return { results, restricted };
}

/**
 * Marks a released or verified result reviewed, once: it leaves every
 * results-to-review list. A sensitive one is reviewed only by someone who
 * may see it, through their break-glass grant if need be.
 */
export async function markReviewed(
  tx: AppDb,
  facilityId: string,
  resultId: string,
  actor: PatientActor,
  at = new Date(),
): Promise<{ resultId: string; reviewedBy: { membershipId: string; name: string }; reviewedAt: Date }> {
  const [result] = await tx
    .select({ id: labResults.id, status: labResults.status, specimenId: labResults.specimenId, enteredBy: labResults.enteredBy, verifiedBy: labResults.verifiedBy, orderId: specimens.orderId })
    .from(labResults)
    .innerJoin(specimens, eq(specimens.id, labResults.specimenId))
    .where(eq(labResults.id, resultId.toLowerCase()))
    // Held, so a correction being written settles first and is read as superseded, never reviewed.
    .for("share", { of: labResults })
    .limit(1);
  if (!result)
    throw new ReviewError("not_found");
  const order = (await orderGuards(tx, [result.orderId])).get(result.orderId)!;
  const guard = { categories: order.categories, recordedBy: [...order.recordedBy, result.enteredBy, result.verifiedBy] };
  if (await isRestricted(tx, { facilityId, patientId: order.patientId, encounterId: order.encounterId }, guard, actor))
    throw new ReviewError("not_found");
  if (result.status !== "released" && result.status !== "verified")
    throw new ReviewError("not_reviewable");

  try {
    await tx.insert(labResultReviews).values({ facilityId, labResultId: result.id, reviewedBy: actor.membershipId, reviewedAt: at });
  }
  catch (err) {
    if (isUniqueViolation(err))
      throw new ReviewError("already_reviewed");
    throw err;
  }
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "lab_result.reviewed",
    entityType: "specimen",
    entityId: result.specimenId,
    summary: "Reviewed a result",
    detail: { resultId: result.id },
  });
  const [me] = await tx.select({ name: user.name }).from(memberships).innerJoin(user, eq(user.id, memberships.userId)).where(eq(memberships.id, actor.membershipId)).limit(1);
  return { resultId: result.id, reviewedBy: { membershipId: actor.membershipId, name: me?.name ?? "" }, reviewedAt: at };
}
