import { and, desc, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { AppDb } from "@/db";

import { accounts, cashierShifts, documents, payments, refunds } from "@/db/schema";

import type { PrintedContent } from "./document-content";
import type { PatientActor } from "./patients";

import { unallocatedCents } from "./allocations";
import { recordAudit } from "./audit";
import { billedFields } from "./billing";
import { issueDocument, voidDocument } from "./documents";
import { formatKes } from "./money";

/**
 * Refunds (SCHEMA.md §7.4): unused credit paid back from one payment.
 *
 * A biller asks; the finance manager or the facility admin approves, never
 * the person who asked (rule 24; decided 2026-11-06). Approving takes the
 * payment's lock, then the refund's (M8), and from then until it is reversed
 * the refund holds its share of the payment (M2). A cashier pays it out
 * later, and only then is it numbered and printed (rule 20). Cash and card go
 * back through the cashier's open shift, and cash lowers what the drawer
 * should hold. Reversing cancels an approval not yet paid out, or corrects a
 * payout recorded in error; it is finance's, never whoever paid it out.
 */

type RefundRow = typeof refunds.$inferSelect;
type PaymentRow = typeof payments.$inferSelect;
export type RefundStatus = RefundRow["status"];
export type RefundMethod = NonNullable<RefundRow["method"]>;

export class RefundError extends Error {
  constructor(readonly code:
    | "payment_not_found"
    | "payment_reversed"
    | "nothing_to_refund"
    | "exceeds_payment"
    | "not_found"
    | "not_pending"
    | "same_person"
    | "not_requester"
    | "not_approved"
    | "already_paid"
    | "already_reversed"
    | "shift_required"
    | "paid_by_you") {
    super({
      payment_not_found: "No such payment",
      payment_reversed: "This payment has been reversed",
      nothing_to_refund: "Nothing is left on this payment to refund",
      exceeds_payment: "That is more than is left on the payment",
      not_found: "No such refund",
      not_pending: "This refund has already been decided",
      same_person: "Someone other than the requester must decide this",
      not_requester: "Only the person who asked can withdraw it",
      not_approved: "Only an approved refund is paid out or reversed",
      already_paid: "This refund has already been paid out",
      already_reversed: "This refund is already reversed",
      shift_required: "Open a shift before paying out cash or card",
      paid_by_you: "Someone other than the person who paid it out must reverse it",
    }[code]);
    this.name = "RefundError";
  }
}

const METHODS: Record<RefundMethod, string> = { cash: "Cash", card: "Card", bank: "Bank transfer", mpesa: "M-Pesa" };

async function findPayment(tx: AppDb, paymentId: string, lock: boolean): Promise<PaymentRow> {
  const query = tx.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
  const [payment] = lock ? await query.for("update") : await query;
  if (!payment)
    throw new RefundError("payment_not_found");
  if (payment.reversedAt)
    throw new RefundError("payment_reversed");
  return payment;
}

async function lockRefund(tx: AppDb, id: string): Promise<RefundRow> {
  const [refund] = await tx.select().from(refunds).where(eq(refunds.id, id)).for("update").limit(1);
  if (!refund)
    throw new RefundError("not_found");
  return refund;
}

async function lockPending(tx: AppDb, id: string): Promise<RefundRow> {
  const refund = await lockRefund(tx, id);
  if (refund.status !== "pending")
    throw new RefundError("not_pending");
  return refund;
}

/** Asks to refund `amountCents` of a payment, or by default all it has left. */
export async function requestRefund(
  tx: AppDb,
  facilityId: string,
  input: { paymentId: string; amountCents?: number; reason: string },
  actor: PatientActor,
): Promise<string> {
  // No lock: a request holds nothing, and approval checks again under the payment's lock.
  const payment = await findPayment(tx, input.paymentId, false);
  const free = await unallocatedCents(tx, payment);
  const amountCents = input.amountCents ?? free;
  if (amountCents <= 0)
    throw new RefundError("nothing_to_refund");
  if (amountCents > free)
    throw new RefundError("exceeds_payment");

  const [refund] = await tx.insert(refunds).values({
    facilityId,
    paymentId: payment.id,
    accountId: payment.accountId,
    amountCents,
    reason: input.reason,
    requestedBy: actor.membershipId,
  }).returning({ id: refunds.id });

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "refund.requested",
    entityType: "refund",
    entityId: refund.id,
    summary: `Asked to refund ${formatKes(amountCents)}`,
    detail: { paymentId: payment.id, amountCents },
  });
  return refund.id;
}

export async function approveRefund(tx: AppDb, facilityId: string, id: string, actor: PatientActor, at = new Date()) {
  const [found] = await tx.select({ paymentId: refunds.paymentId }).from(refunds).where(eq(refunds.id, id)).limit(1);
  if (!found)
    throw new RefundError("not_found");
  // The payment's lock first, then the refund's (M8).
  const payment = await findPayment(tx, found.paymentId, true);
  const refund = await lockPending(tx, id);
  if (refund.requestedBy === actor.membershipId)
    throw new RefundError("same_person");
  if (refund.amountCents > await unallocatedCents(tx, payment))
    throw new RefundError("exceeds_payment");

  await tx.update(refunds).set({ status: "approved", decidedBy: actor.membershipId, decidedAt: at }).where(eq(refunds.id, id));
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "refund.approved",
    entityType: "refund",
    entityId: id,
    summary: `Approved a refund of ${formatKes(refund.amountCents)}`,
    detail: { paymentId: refund.paymentId, amountCents: refund.amountCents },
  });
}

export async function rejectRefund(tx: AppDb, facilityId: string, id: string, actor: PatientActor) {
  const refund = await lockPending(tx, id);
  if (refund.requestedBy === actor.membershipId)
    throw new RefundError("same_person");

  await tx.update(refunds).set({ status: "rejected", decidedBy: actor.membershipId, decidedAt: new Date() }).where(eq(refunds.id, id));
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "refund.rejected",
    entityType: "refund",
    entityId: id,
    summary: `Rejected a refund of ${formatKes(refund.amountCents)}`,
    detail: { paymentId: refund.paymentId },
  });
}

export async function withdrawRefund(tx: AppDb, facilityId: string, id: string, actor: PatientActor) {
  const refund = await lockPending(tx, id);
  if (refund.requestedBy !== actor.membershipId)
    throw new RefundError("not_requester");

  await tx.update(refunds).set({ status: "withdrawn", decidedBy: actor.membershipId, decidedAt: new Date() }).where(eq(refunds.id, id));
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "refund.withdrawn",
    entityType: "refund",
    entityId: id,
    summary: `Withdrew a refund of ${formatKes(refund.amountCents)}`,
    detail: { paymentId: refund.paymentId },
  });
}

/** What a refund prints, frozen when it is paid out (rule 7). */
async function printedRefund(tx: AppDb, refund: RefundRow, payout: { method: RefundMethod; reference: string | null }): Promise<PrintedContent> {
  const [account] = await tx.select({ patientId: accounts.patientId }).from(accounts).where(eq(accounts.id, refund.accountId)).limit(1);
  const [receipt] = await tx
    .select({ number: documents.number })
    .from(payments)
    .innerJoin(documents, eq(documents.id, payments.documentId))
    .where(eq(payments.id, refund.paymentId))
    .limit(1);

  return {
    title: "Refund",
    fields: [
      ...(await billedFields(tx, refund.accountId, account.patientId!)).map(f => f.label === "Bill to" ? { label: "Paid to", value: f.value } : f),
      { label: "Refund of", value: `Receipt ${receipt.number}` },
      { label: "Reason", value: refund.reason },
      { label: "Paid by", value: METHODS[payout.method] },
      ...(payout.reference ? [{ label: "Reference", value: payout.reference }] : []),
    ],
    totals: [{ label: "Amount refunded", value: formatKes(refund.amountCents) }],
  };
}

/**
 * Pays out an approved refund: numbered and printed now. Cash and card come
 * from the cashier's own open shift, held with a share lock so it cannot
 * close underneath.
 */
export async function payRefund(
  tx: AppDb,
  facilityId: string,
  id: string,
  input: { method: RefundMethod; reference?: string },
  actor: PatientActor,
  at = new Date(),
): Promise<{ number: string }> {
  let shiftId: string | null = null;
  if (input.method === "cash" || input.method === "card") {
    const [shift] = await tx
      .select({ id: cashierShifts.id })
      .from(cashierShifts)
      .where(and(eq(cashierShifts.cashierId, actor.membershipId), isNull(cashierShifts.closedAt)))
      .for("share")
      .limit(1);
    if (!shift)
      throw new RefundError("shift_required");
    shiftId = shift.id;
  }

  const refund = await lockRefund(tx, id);
  if (refund.status !== "approved")
    throw new RefundError("not_approved");
  if (refund.reversedAt)
    throw new RefundError("already_reversed");
  if (refund.paidAt)
    throw new RefundError("already_paid");

  const reference = input.method === "cash" ? null : input.reference ?? null;
  const document = await issueDocument(tx, {
    facilityId,
    kind: "refund",
    content: await printedRefund(tx, refund, { method: input.method, reference }),
    issuedBy: actor,
    at,
  });
  await tx.update(refunds).set({
    paidAt: at,
    paidBy: actor.membershipId,
    method: input.method,
    reference,
    cashierShiftId: shiftId,
    documentId: document.id,
  }).where(eq(refunds.id, id));

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "refund.paid",
    entityType: "refund",
    entityId: id,
    summary: `Paid out a refund of ${formatKes(refund.amountCents)} by ${METHODS[input.method].toLowerCase()}, ${document.number}`,
    detail: { paymentId: refund.paymentId, amountCents: refund.amountCents, method: input.method, number: document.number },
  });
  return { number: document.number };
}

/**
 * Reverses an approved refund: cancels it if not yet paid out, or corrects a
 * payout recorded in error, voiding its document. Either way its amount
 * returns to the payment's credit.
 */
export async function reverseRefund(tx: AppDb, facilityId: string, id: string, reason: string, actor: PatientActor, at = new Date()) {
  const refund = await lockRefund(tx, id);
  if (refund.status !== "approved")
    throw new RefundError("not_approved");
  if (refund.reversedAt)
    throw new RefundError("already_reversed");
  if (refund.paidBy === actor.membershipId)
    throw new RefundError("paid_by_you");

  if (refund.documentId)
    await voidDocument(tx, { facilityId, documentId: refund.documentId, reason, voidedBy: actor, at });
  await tx.update(refunds)
    .set({ reversedAt: at, reversedBy: actor.membershipId, reversalReason: reason })
    .where(eq(refunds.id, id));

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "refund.reversed",
    entityType: "refund",
    entityId: id,
    summary: `${refund.paidAt ? "Reversed a refund paid out" : "Cancelled an approved refund"} of ${formatKes(refund.amountCents)}: ${reason}`,
    detail: { paymentId: refund.paymentId, amountCents: refund.amountCents, paid: refund.paidAt !== null, reason },
  });
}

/** Refunds, newest first: the approver's queue at `pending`, the cashier's at `approved`. Names no patient. */
export async function listRefunds(tx: AppDb, filter: { status?: RefundStatus; id?: string } = {}) {
  const receipt = alias(documents, "receipt");
  return tx
    .select({
      id: refunds.id,
      paymentId: refunds.paymentId,
      receiptNumber: receipt.number,
      /** The refund's own number, once paid out. */
      number: documents.number,
      amountCents: refunds.amountCents,
      reason: refunds.reason,
      status: refunds.status,
      requestedBy: refunds.requestedBy,
      requestedAt: refunds.requestedAt,
      decidedBy: refunds.decidedBy,
      decidedAt: refunds.decidedAt,
      paidBy: refunds.paidBy,
      paidAt: refunds.paidAt,
      method: refunds.method,
      reference: refunds.reference,
      reversedAt: refunds.reversedAt,
      reversalReason: refunds.reversalReason,
    })
    .from(refunds)
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .innerJoin(receipt, eq(receipt.id, payments.documentId))
    .leftJoin(documents, eq(documents.id, refunds.documentId))
    .where(and(
      filter.status ? eq(refunds.status, filter.status) : undefined,
      filter.id ? eq(refunds.id, filter.id) : undefined,
    ))
    .orderBy(desc(refunds.requestedAt), desc(refunds.id))
    .limit(100);
}

export type ListedRefund = Awaited<ReturnType<typeof listRefunds>>[number];
