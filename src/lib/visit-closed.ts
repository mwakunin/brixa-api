import { eq } from "drizzle-orm";

import type { AppDb } from "@/db";

import { encounters, memberships, user } from "@/db/schema";

import { businessDate, businessTimeOfDay, printedDate } from "./dates";
import { clinicCategoriesOf } from "./sensitivity";

/**
 * Why a visit takes no more work, as every refusal of work on it says (after
 * the design review of 2026-11-21): what happened, when, by whom, and what to
 * do. The member of staff reads it as it is. A visit to a sensitive clinic
 * says only that it is no longer open.
 *
 *   This visit was cancelled at 09:40 by Joyce Mwangi. Ask the front desk whether to start a new one.
 */
export async function visitClosedMessage(tx: AppDb, encounterId: string, now = new Date()): Promise<string> {
  const [visit] = await tx
    .select({ status: encounters.status, endedAt: encounters.endedAt, by: user.name })
    .from(encounters)
    .leftJoin(memberships, eq(memberships.id, encounters.closedBy))
    .leftJoin(user, eq(user.id, memberships.userId))
    .where(eq(encounters.id, encounterId))
    .limit(1);
  const next = "Ask the front desk whether to start a new one.";
  if (!visit?.endedAt || visit.status === "open")
    return `This visit is no longer open. ${next}`;
  // A sensitive clinic's visit says no more: when and by whom it closed would be told to readers who may not see it (rule 27).
  if (((await clinicCategoriesOf(tx, [encounterId])).get(encounterId)?.size ?? 0) > 0)
    return `This visit is no longer open. ${next}`;
  const day = businessDate(visit.endedAt);
  const when = day === businessDate(now)
    ? `at ${businessTimeOfDay(visit.endedAt)}`
    : `on ${printedDate(day)} at ${businessTimeOfDay(visit.endedAt)}`;
  if (visit.status === "cancelled")
    return `This visit was cancelled ${when}${visit.by ? ` by ${visit.by}` : ""}. ${next}`;
  // Closed with nobody's name: closed by itself once nothing was left, or at the end of the day.
  return visit.by ? `This visit was closed ${when} by ${visit.by}. ${next}` : `This visit closed by itself ${when}. ${next}`;
}

/** `error` with the visit's closed message in place of its own fixed sentence, to throw. */
export async function closedVisit<E extends Error>(tx: AppDb, encounterId: string, error: E): Promise<E> {
  error.message = await visitClosedMessage(tx, encounterId);
  return error;
}
