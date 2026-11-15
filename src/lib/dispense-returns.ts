import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { billableItems, chargeAssignments, dispenseLines, dispenseReturns, dispenses, drugCatalogue, encounters, invoiceLines, invoices, stockBatches, stockItems, stockMovements } from "@/db/schema";

import type { DispenseActor } from "./dispensing";
import type { PatientActor } from "./patients";

import { AdjustmentError, requestAdjustment } from "./adjustments";
import { recordAudit } from "./audit";
import { assignedByCharge } from "./billing";
import { dispenseCharges, replaceDispenseCharge } from "./charges";
import { businessDate } from "./dates";
import { mayGiveControlled } from "./dispensing";
import { chargeAmountCents } from "./money";
import { lockBatches } from "./stock-levels";

/**
 * Medicines a patient brings back (SCHEMA.md §8, P4 slice 3b, decided
 * 2026-11-15). One fit to sell again goes back on the pharmacy's shelf, into
 * the latest-expiring batch it came from, and the patient is credited at
 * once; one that is not is a write-off a second person approves before the
 * patient is credited. Credited by a replacement charge while unbilled, or
 * a credit note asked for once billed.
 *
 * Lock order: the encounter (M8), the dispense, the batches, the charges.
 */

type ReturnRow = typeof dispenseReturns.$inferSelect;

export type ReturnErrorCode
  = | "line_not_found"
    | "not_found"
    | "not_handed_over"
    | "more_than_given"
    | "nowhere_to_return"
    | "controlled_dispenser"
    | "not_pending"
    | "same_person"
    | "on_draft_bill"
    | "split_billed"
    | "bill_paid";

export class ReturnError extends Error {
  constructor(readonly code: ReturnErrorCode) {
    super({
      line_not_found: "No such dispensed medicine",
      not_found: "No such return",
      not_handed_over: "Only a medicine handed over comes back; a prepared one is cancelled",
      more_than_given: "More than was given, less what has come back already",
      nowhere_to_return: "Every batch it came from has expired: it cannot go back on the shelf, so take it back as unfit",
      controlled_dispenser: "A controlled drug is taken back by a pharmacist with a pharmacy licence",
      not_pending: "This return has already been decided",
      same_person: "Someone other than whoever took it back decides this",
      on_draft_bill: "Its charge is on a draft bill: finalise or discard the draft first",
      split_billed: "Its charge is billed in part, or across bills: billing credits it by hand",
      bill_paid: "Its bill is paid: the cashier frees the payment first, then the credit can be asked for and the money refunded",
    }[code]);
    this.name = "ReturnError";
  }
}

interface LineContext {
  id: string;
  quantity: number;
  dispenseId: string;
  storeId: string;
  encounterId: string;
  schedule: string | null;
  code: string;
}

/** The line, its encounter and dispense locked (M8), refusing one not handed over. */
async function lockLine(tx: AppDb, lineId: string): Promise<LineContext> {
  const [found] = await tx
    .select({ id: dispenseLines.id, quantity: dispenseLines.quantity, dispenseId: dispenseLines.dispenseId, encounterId: dispenses.encounterId, storeId: dispenses.storeId, schedule: drugCatalogue.controlledSchedule, code: billableItems.code })
    .from(dispenseLines)
    .innerJoin(dispenses, eq(dispenses.id, dispenseLines.dispenseId))
    .innerJoin(stockItems, eq(stockItems.id, dispenseLines.stockItemId))
    .innerJoin(billableItems, eq(billableItems.id, stockItems.billableItemId))
    .leftJoin(drugCatalogue, eq(drugCatalogue.code, stockItems.drugCode))
    .where(eq(dispenseLines.id, lineId))
    .limit(1);
  if (!found)
    throw new ReturnError("line_not_found");
  await tx.select({ id: encounters.id }).from(encounters).where(eq(encounters.id, found.encounterId)).for("update");
  const [dispense] = await tx.select({ status: dispenses.status }).from(dispenses).where(eq(dispenses.id, found.dispenseId)).for("update");
  if (dispense.status !== "handed_over")
    throw new ReturnError("not_handed_over");
  return found;
}

/** What has come back of a line: credited (`done`), or waiting to be (`pending`); `except` one return. */
async function returnedOf(tx: AppDb, lineId: string, statuses: ReturnRow["status"][], except?: string): Promise<number> {
  const [{ total }] = await tx.select({ total: sql<string>`coalesce(sum(${dispenseReturns.quantity}), 0)` }).from(dispenseReturns).where(and(eq(dispenseReturns.dispenseLineId, lineId), inArray(dispenseReturns.status, statuses), except ? ne(dispenseReturns.id, except) : undefined));
  return Number(total);
}

/**
 * Puts a fit return back on the shelf: into the batches the line came from,
 * latest expiry first, never an expired one, and never more into a batch
 * than came out of it for this line.
 */
async function backOnShelf(tx: AppDb, facilityId: string, line: LineContext, quantity: number, actor: PatientActor, today: string): Promise<void> {
  const moved = await tx
    .select({ batchId: stockMovements.batchId, expiresOn: stockBatches.expiresOn, room: sql<string>`sum(-${stockMovements.quantity})` })
    .from(stockMovements)
    .innerJoin(stockBatches, eq(stockBatches.id, stockMovements.batchId))
    .where(and(eq(stockMovements.dispenseLineId, line.id), eq(stockMovements.kind, "dispense")))
    .groupBy(stockMovements.batchId, stockBatches.expiresOn);
  await lockBatches(tx, facilityId, moved.map(m => m.batchId));
  const back = await tx
    .select({ batchId: stockMovements.batchId, total: sql<string>`sum(${stockMovements.quantity})` })
    .from(stockMovements)
    .where(and(eq(stockMovements.dispenseLineId, line.id), eq(stockMovements.kind, "dispense_returned")))
    .groupBy(stockMovements.batchId);
  const backOf = new Map(back.map(b => [b.batchId, Number(b.total)]));

  const into = moved
    .filter(m => m.expiresOn === null || m.expiresOn >= today)
    .sort((a, b) => (b.expiresOn ?? "9999").localeCompare(a.expiresOn ?? "9999"));
  let left = quantity;
  const rows = [];
  for (const m of into) {
    const room = Number(m.room) - (backOf.get(m.batchId) ?? 0);
    const put = Math.min(room, left);
    if (put > 0) {
      rows.push({ facilityId, storeId: line.storeId, batchId: m.batchId, kind: "dispense_returned" as const, quantity: put, dispenseLineId: line.id, recordedBy: actor.membershipId });
      left -= put;
    }
  }
  if (left > 0)
    throw new ReturnError("nowhere_to_return");
  await tx.insert(stockMovements).values(rows);
}

/** The bill a billed charge is on, if exactly one finalised one. */
async function billOf(tx: AppDb, chargeId: string): Promise<string> {
  const bills = await tx
    .selectDistinct({ id: invoices.id, status: invoices.status })
    .from(chargeAssignments)
    .innerJoin(invoiceLines, eq(invoiceLines.id, chargeAssignments.invoiceLineId))
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(and(eq(chargeAssignments.chargeId, chargeId), ne(invoices.status, "void")));
  if (bills.length > 1)
    throw new ReturnError("split_billed");
  if (bills[0].status !== "finalised")
    throw new ReturnError("on_draft_bill");
  return bills[0].id;
}

/**
 * Credits the patient for a return: a replacement charge for what was kept
 * while the charge is unbilled, or a credit note asked for once it is
 * billed. Answers the credit note's adjustment, if one was asked for.
 */
async function credit(tx: AppDb, facilityId: string, line: LineContext, ret: ReturnRow, actor: PatientActor): Promise<string | null> {
  const [charge] = await dispenseCharges(tx, [line.id]);
  if (!charge)
    return null;
  const keptBefore = line.quantity - await returnedOf(tx, line.id, ["done"], ret.id);
  const keptAfter = keptBefore - ret.quantity;
  const reason = `Returned ${ret.quantity} of ${line.code}: ${ret.reason}`;

  const assigned = (await assignedByCharge(tx, [charge.id])).get(charge.id) ?? 0;
  if (assigned === 0) {
    await replaceDispenseCharge(tx, facilityId, charge, keptAfter, reason, actor);
    return null;
  }
  // Billed in part (a payer's share and the patient's, P7): which part the return comes off is billing's call.
  if (assigned !== charge.amountCents)
    throw new ReturnError("split_billed");
  const amountCents = chargeAmountCents(String(keptBefore), charge.unitPriceCents) - chargeAmountCents(String(keptAfter), charge.unitPriceCents);
  if (amountCents === 0)
    return null;
  try {
    return await requestAdjustment(tx, facilityId, { invoiceId: await billOf(tx, charge.id), kind: "credit_note", amountCents, reason }, actor);
  }
  catch (err) {
    if (err instanceof AdjustmentError && err.code === "exceeds_balance")
      throw new ReturnError("bill_paid");
    throw err;
  }
}

/**
 * Takes back what a patient returns of a medicine handed over. Fit to sell
 * again, it goes back on the shelf and the patient is credited now; unfit,
 * it waits for a second person.
 */
export async function recordReturn(
  tx: AppDb,
  facilityId: string,
  lineId: string,
  input: { quantity: number; reason: string; fitForResale: boolean },
  actor: DispenseActor,
  today = businessDate(),
): Promise<ReturnRow> {
  const line = await lockLine(tx, lineId);
  if (line.schedule && !mayGiveControlled(actor))
    throw new ReturnError("controlled_dispenser");
  if (input.quantity > line.quantity - await returnedOf(tx, line.id, ["done", "pending"]))
    throw new ReturnError("more_than_given");

  const [ret] = await tx.insert(dispenseReturns).values({
    facilityId,
    dispenseLineId: line.id,
    quantity: input.quantity,
    reason: input.reason,
    fitForResale: input.fitForResale,
    status: input.fitForResale ? "done" : "pending",
    receivedBy: actor.membershipId,
  }).returning();
  let adjustmentId: string | null = null;
  if (input.fitForResale) {
    await backOnShelf(tx, facilityId, line, input.quantity, actor, today);
    adjustmentId = await credit(tx, facilityId, line, ret, actor);
    if (adjustmentId)
      await tx.update(dispenseReturns).set({ invoiceAdjustmentId: adjustmentId }).where(eq(dispenseReturns.id, ret.id));
  }
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "dispense.returned",
    entityType: "encounter",
    entityId: line.encounterId,
    summary: `Took back ${input.quantity} of ${line.code}${input.fitForResale ? "" : ", unfit to sell again"}`,
    detail: { returnId: ret.id, dispenseLineId: line.id, quantity: input.quantity, fitForResale: input.fitForResale, reason: input.reason, invoiceAdjustmentId: adjustmentId },
  });
  return { ...ret, invoiceAdjustmentId: adjustmentId };
}

async function lockPending(tx: AppDb, id: string, actor: PatientActor): Promise<{ ret: ReturnRow; line: LineContext }> {
  const [found] = await tx.select({ lineId: dispenseReturns.dispenseLineId }).from(dispenseReturns).where(eq(dispenseReturns.id, id)).limit(1);
  if (!found)
    throw new ReturnError("not_found");
  const line = await lockLine(tx, found.lineId);
  const [ret] = await tx.select().from(dispenseReturns).where(eq(dispenseReturns.id, id)).for("update");
  if (ret.status !== "pending")
    throw new ReturnError("not_pending");
  if (ret.receivedBy === actor.membershipId)
    throw new ReturnError("same_person");
  return { ret, line };
}

/** A second person accepts an unfit return's loss (rule 24), and the patient is credited. */
export async function approveReturn(tx: AppDb, facilityId: string, id: string, actor: PatientActor): Promise<ReturnRow> {
  const { ret, line } = await lockPending(tx, id, actor);
  const adjustmentId = await credit(tx, facilityId, line, ret, actor);
  const [approved] = await tx.update(dispenseReturns)
    .set({ status: "done", decidedBy: actor.membershipId, decidedAt: new Date(), invoiceAdjustmentId: adjustmentId })
    .where(eq(dispenseReturns.id, id))
    .returning();
  await recordAudit(tx, { facilityId, actorId: actor.userId, action: "dispense_return.approved", entityType: "encounter", entityId: line.encounterId, summary: `Approved an unfit return of ${ret.quantity} of ${line.code}`, detail: { returnId: id, invoiceAdjustmentId: adjustmentId } });
  return approved;
}

/** A second person refuses an unfit return: the patient is not credited. */
export async function rejectReturn(tx: AppDb, facilityId: string, id: string, actor: PatientActor): Promise<ReturnRow> {
  const { ret, line } = await lockPending(tx, id, actor);
  const [rejected] = await tx.update(dispenseReturns).set({ status: "rejected", decidedBy: actor.membershipId, decidedAt: new Date() }).where(eq(dispenseReturns.id, id)).returning();
  await recordAudit(tx, { facilityId, actorId: actor.userId, action: "dispense_return.rejected", entityType: "encounter", entityId: line.encounterId, summary: `Rejected an unfit return of ${ret.quantity} of ${line.code}`, detail: { returnId: id } });
  return rejected;
}

export interface ListedReturn {
  id: string;
  dispenseLineId: string;
  encounterId: string;
  code: string;
  name: string;
  quantity: number;
  reason: string;
  fitForResale: boolean;
  status: ReturnRow["status"];
  receivedAt: Date;
  invoiceAdjustmentId: string | null;
}

/**
 * Returns, newest first, 50 a page; `pending` is the approvers' list. Each
 * names a visit and what its patient brought back, so the list is audited
 * (rule 9), with ids only.
 */
export async function viewReturns(tx: AppDb, facilityId: string, filter: { status?: ReturnRow["status"]; offset?: number }, actor: PatientActor): Promise<ListedReturn[]> {
  const listed = await listReturns(tx, filter);
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "dispense_return.listed",
    entityType: "facility",
    entityId: facilityId,
    summary: `Viewed ${listed.length} return${listed.length === 1 ? "" : "s"}`,
    detail: { status: filter.status ?? null, encounters: [...new Set(listed.map(r => r.encounterId))] },
  });
  return listed;
}

/** Returns as `viewReturns` lists them; not audited, for answering a write. */
export async function listReturns(tx: AppDb, filter: { status?: ReturnRow["status"]; id?: string; offset?: number } = {}): Promise<ListedReturn[]> {
  const rows = await tx
    .select({ ret: dispenseReturns, encounterId: dispenses.encounterId, code: billableItems.code, name: billableItems.name })
    .from(dispenseReturns)
    .innerJoin(dispenseLines, eq(dispenseLines.id, dispenseReturns.dispenseLineId))
    .innerJoin(dispenses, eq(dispenses.id, dispenseLines.dispenseId))
    .innerJoin(stockItems, eq(stockItems.id, dispenseLines.stockItemId))
    .innerJoin(billableItems, eq(billableItems.id, stockItems.billableItemId))
    .where(and(filter.status ? eq(dispenseReturns.status, filter.status) : undefined, filter.id ? eq(dispenseReturns.id, filter.id) : undefined))
    .orderBy(desc(dispenseReturns.receivedAt), desc(dispenseReturns.id))
    .limit(50)
    .offset(filter.offset ?? 0);
  return rows.map(({ ret, encounterId, code, name }) => ({
    id: ret.id,
    dispenseLineId: ret.dispenseLineId,
    encounterId,
    code,
    name,
    quantity: ret.quantity,
    reason: ret.reason,
    fitForResale: ret.fitForResale,
    status: ret.status,
    receivedAt: ret.receivedAt,
    invoiceAdjustmentId: ret.invoiceAdjustmentId,
  }));
}

export async function returnShown(tx: AppDb, id: string): Promise<ListedReturn> {
  const [found] = await listReturns(tx, { id });
  if (!found)
    throw new ReturnError("not_found");
  return found;
}
