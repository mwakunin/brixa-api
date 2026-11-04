import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { accounts, admissions, allocations, cashierShifts, documents, encounters, invoices, patients, payments } from "@/db/schema";

import type { PrintedContent } from "./document-content";
import type { PatientActor } from "./patients";

import { allocate, unallocatedCents } from "./allocations";
import { recordAudit } from "./audit";
import { billedFields, ensureAccount } from "./billing";
import { isUniqueViolation } from "./db-errors";
import { issueDocument, voidDocument } from "./documents";
import { balanceCents } from "./invoice-balance";
import { formatKes } from "./money";

/**
 * Cashier shifts and payments (SCHEMA.md §7.4).
 *
 * Recording money and settling bills are two acts. A payment lands as credit
 * on the patient's account, with its receipt issued in the same transaction;
 * when it is taken against a bill, as much as the bill still owes is
 * allocated to it at once, and the rest stays as credit. Credit tagged to a
 * visit or admission (a deposit) settles that encounter's bill when it is
 * finalised. Cash and card are taken inside the cashier's open shift.
 */

type PaymentRow = typeof payments.$inferSelect;
type ShiftRow = typeof cashierShifts.$inferSelect;
export type PaymentMethod = PaymentRow["method"];

export class PaymentError extends Error {
  constructor(readonly code:
    | "shift_open"
    | "shift_required"
    | "shift_not_found"
    | "shift_closed"
    | "not_your_shift"
    | "patient_not_found"
    | "encounter_not_found"
    | "encounter_cancelled"
    | "invoice_not_found"
    | "not_finalised"
    | "other_patient"
    | "payment_not_found"
    | "already_reversed"
    | "same_person") {
    super({
      shift_open: "You already have a shift open",
      shift_required: "Open a shift before taking cash or card",
      shift_not_found: "No such shift",
      shift_closed: "This shift is already closed",
      not_your_shift: "Only the cashier whose shift it is can close it",
      patient_not_found: "No such patient",
      encounter_not_found: "No such visit or admission",
      encounter_cancelled: "That visit was cancelled",
      invoice_not_found: "No such invoice",
      not_finalised: "Only a finalised invoice is paid",
      other_patient: "That bill or visit is another patient's",
      payment_not_found: "No such payment",
      already_reversed: "This payment is already reversed",
      same_person: "Someone other than the person who took it must reverse it",
    }[code]);
    this.name = "PaymentError";
  }
}

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

export async function openShift(tx: AppDb, facilityId: string, openingFloatCents: number, actor: PatientActor): Promise<string> {
  try {
    // A savepoint, so a refused second shift leaves the request's transaction usable.
    return await tx.transaction(async (sp) => {
      const [shift] = await sp.insert(cashierShifts)
        .values({ facilityId, cashierId: actor.membershipId, openingFloatCents })
        .returning({ id: cashierShifts.id });
      await recordAudit(sp, {
        facilityId,
        actorId: actor.userId,
        action: "shift.opened",
        entityType: "cashier_shift",
        entityId: shift.id,
        summary: `Opened a shift with a float of ${formatKes(openingFloatCents)}`,
      });
      return shift.id;
    });
  }
  catch (err) {
    if (isUniqueViolation(err))
      throw new PaymentError("shift_open");
    throw err;
  }
}

/** A shift with its takings, derived: cash expected in the drawer, and the variance once closed. */
export async function shiftSummary(tx: AppDb, shiftId: string) {
  const [shift] = await tx.select().from(cashierShifts).where(eq(cashierShifts.id, shiftId)).limit(1);
  if (!shift)
    throw new PaymentError("shift_not_found");

  const takings = await tx
    .select({
      method: payments.method,
      cents: sql<number>`coalesce(sum(${payments.amountCents}), 0)`.mapWith(Number),
      count: sql<number>`count(*)`.mapWith(Number),
    })
    .from(payments)
    .where(and(eq(payments.cashierShiftId, shiftId), isNull(payments.reversedAt)))
    .groupBy(payments.method);
  const of = (method: PaymentMethod) => takings.find(t => t.method === method) ?? { cents: 0, count: 0 };

  // Slice 5b subtracts cash refunds paid from the drawer.
  const expectedCashCents = shift.openingFloatCents + of("cash").cents;
  return {
    ...shift,
    cashCents: of("cash").cents,
    cardCents: of("card").cents,
    paymentCount: of("cash").count + of("card").count,
    expectedCashCents,
    varianceCents: shift.declaredCashCents === null ? null : shift.declaredCashCents - expectedCashCents,
  };
}

export type ShiftSummary = Awaited<ReturnType<typeof shiftSummary>>;

export async function currentShift(tx: AppDb, membershipId: string): Promise<ShiftRow | null> {
  const [shift] = await tx
    .select()
    .from(cashierShifts)
    .where(and(eq(cashierShifts.cashierId, membershipId), isNull(cashierShifts.closedAt)))
    .limit(1);
  return shift ?? null;
}

/** Closes the cashier's own shift with the cash they counted. */
export async function closeShift(tx: AppDb, facilityId: string, shiftId: string, declaredCashCents: number, actor: PatientActor) {
  const [shift] = await tx.select().from(cashierShifts).where(eq(cashierShifts.id, shiftId)).for("update").limit(1);
  if (!shift)
    throw new PaymentError("shift_not_found");
  if (shift.cashierId !== actor.membershipId)
    throw new PaymentError("not_your_shift");
  if (shift.closedAt)
    throw new PaymentError("shift_closed");

  await tx.update(cashierShifts).set({ closedAt: new Date(), declaredCashCents }).where(eq(cashierShifts.id, shiftId));
  const summary = await shiftSummary(tx, shiftId);

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "shift.closed",
    entityType: "cashier_shift",
    entityId: shiftId,
    summary: `Closed a shift: ${formatKes(declaredCashCents)} counted, ${formatKes(summary.expectedCashCents)} expected`,
    detail: { declaredCashCents, expectedCashCents: summary.expectedCashCents, varianceCents: summary.varianceCents },
  });
  return summary;
}

/** Recent shifts, newest first, for finance to review. */
export async function listShifts(tx: AppDb) {
  return tx.select().from(cashierShifts).orderBy(desc(cashierShifts.openedAt), desc(cashierShifts.id)).limit(50);
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

const METHODS: Record<PaymentMethod, string> = { cash: "Cash", card: "Card", bank: "Bank transfer" };

export interface PaymentInput {
  patientId: string;
  method: PaymentMethod;
  amountCents: number;
  reference?: string;
  /** Paid towards this visit or admission: a deposit. */
  encounterId?: string;
  /** Paid against this bill: as much as it owes is applied at once. */
  invoiceId?: string;
}

/** What the payment is for, checked against the patient: an invoice, an encounter, or neither. */
async function paymentTarget(tx: AppDb, input: PaymentInput, accountId: string) {
  if (input.invoiceId) {
    // Locked now, before the payment exists (M8: payment, then invoice).
    const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).for("update").limit(1);
    if (!invoice)
      throw new PaymentError("invoice_not_found");
    if (invoice.accountId !== accountId)
      throw new PaymentError("other_patient");
    if (invoice.status !== "finalised")
      throw new PaymentError("not_finalised");
    const [document] = await tx.select({ number: documents.number }).from(documents).where(eq(documents.id, invoice.documentId!)).limit(1);
    return { encounterId: invoice.encounterId, invoice, invoiceNumber: document.number, owedCents: await balanceCents(tx, invoice) };
  }

  if (input.encounterId) {
    const [encounter] = await tx.select().from(encounters).where(eq(encounters.id, input.encounterId)).limit(1);
    if (!encounter)
      throw new PaymentError("encounter_not_found");
    if (encounter.patientId !== input.patientId)
      throw new PaymentError("other_patient");
    if (encounter.status === "cancelled")
      throw new PaymentError("encounter_cancelled");
    return { encounterId: encounter.id, invoice: null, invoiceNumber: null, owedCents: 0 };
  }

  return { encounterId: null, invoice: null, invoiceNumber: null, owedCents: 0 };
}

async function depositFor(tx: AppDb, encounterId: string): Promise<string> {
  const [admission] = await tx.select({ number: admissions.admissionNumber }).from(admissions).where(eq(admissions.encounterId, encounterId)).limit(1);
  return admission ? `Deposit, admission ${admission.number}` : "Deposit for this visit";
}

/** What the receipt prints, frozen when it is issued (rule 7). */
async function printedReceipt(
  tx: AppDb,
  input: PaymentInput,
  accountId: string,
  target: Awaited<ReturnType<typeof paymentTarget>>,
  appliedCents: number,
): Promise<PrintedContent> {
  const forWhat = target.invoiceNumber
    ? `Invoice ${target.invoiceNumber}`
    : target.encounterId ? await depositFor(tx, target.encounterId) : "Credit on account";

  return {
    title: "Receipt",
    fields: [
      ...(await billedFields(tx, accountId, input.patientId)).map(f => f.label === "Bill to" ? { label: "Received from", value: f.value } : f),
      { label: "For", value: forWhat },
      { label: "Paid by", value: METHODS[input.method] },
      ...(input.reference ? [{ label: "Reference", value: input.reference }] : []),
    ],
    totals: [
      { label: "Amount received", value: formatKes(input.amountCents) },
      ...(target.invoice
        ? [
            { label: "Applied to the bill", value: formatKes(appliedCents) },
            { label: "Still owed on the bill", value: formatKes(target.owedCents - appliedCents) },
          ]
        : []),
    ],
  };
}

/** Records money received from a patient, issues its receipt, and applies it to the bill named. */
export async function recordPayment(tx: AppDb, facilityId: string, input: PaymentInput, actor: PatientActor, at = new Date()): Promise<string> {
  const [patient] = await tx.select({ id: patients.id }).from(patients).where(eq(patients.id, input.patientId)).limit(1);
  if (!patient)
    throw new PaymentError("patient_not_found");

  let shiftId: string | null = null;
  if (input.method === "cash" || input.method === "card") {
    // A share lock, so the shift cannot close under this payment.
    const [shift] = await tx
      .select({ id: cashierShifts.id })
      .from(cashierShifts)
      .where(and(eq(cashierShifts.cashierId, actor.membershipId), isNull(cashierShifts.closedAt)))
      .for("share")
      .limit(1);
    if (!shift)
      throw new PaymentError("shift_required");
    shiftId = shift.id;
  }

  const accountId = await ensureAccount(tx, facilityId, { patientId: patient.id });
  const target = await paymentTarget(tx, input, accountId);
  const appliedCents = Math.min(input.amountCents, target.owedCents);

  const receipt = await issueDocument(tx, {
    facilityId,
    kind: "receipt",
    content: await printedReceipt(tx, input, accountId, target, appliedCents),
    issuedBy: actor,
    at,
  });
  const [payment] = await tx.insert(payments).values({
    facilityId,
    accountId,
    method: input.method,
    amountCents: input.amountCents,
    reference: input.method === "cash" ? null : input.reference,
    cashierShiftId: shiftId,
    encounterId: target.encounterId,
    documentId: receipt.id,
    receivedAt: at,
    receivedBy: actor.membershipId,
  }).returning({ id: payments.id });

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "payment.recorded",
    entityType: "payment",
    entityId: payment.id,
    summary: `Received ${formatKes(input.amountCents)} by ${METHODS[input.method].toLowerCase()}, receipt ${receipt.number}`,
    detail: { patientId: patient.id, method: input.method, amountCents: input.amountCents, receipt: receipt.number, invoiceId: input.invoiceId ?? null },
  });

  if (target.invoice && appliedCents > 0)
    await allocate(tx, facilityId, { paymentId: payment.id, invoiceId: target.invoice.id, amountCents: appliedCents }, actor);
  return payment.id;
}

/**
 * Reverses a payment recorded in error: its receipt is voided, and its
 * allocations stop counting. By finance, never by whoever took it
 * (decided 2026-11-04). Slice 5b refuses it once a refund is paid from it.
 */
export async function reversePayment(tx: AppDb, facilityId: string, paymentId: string, reason: string, actor: PatientActor, at = new Date()) {
  const [payment] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for("update").limit(1);
  if (!payment)
    throw new PaymentError("payment_not_found");
  if (payment.reversedAt)
    throw new PaymentError("already_reversed");
  if (payment.receivedBy === actor.membershipId)
    throw new PaymentError("same_person");

  await voidDocument(tx, { facilityId, documentId: payment.documentId, reason, voidedBy: actor, at });
  await tx.update(payments)
    .set({ reversedAt: at, reversedBy: actor.membershipId, reversalReason: reason })
    .where(eq(payments.id, paymentId));

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "payment.reversed",
    entityType: "payment",
    entityId: paymentId,
    summary: `Reversed a payment of ${formatKes(payment.amountCents)}: ${reason}`,
    detail: { amountCents: payment.amountCents, method: payment.method, reason },
  });
}

/** A payment, its receipt number, where it went, and what is left of it. */
export async function paymentDetail(tx: AppDb, paymentId: string) {
  const [row] = await tx
    .select({ payment: payments, receiptNumber: documents.number })
    .from(payments)
    .innerJoin(documents, eq(documents.id, payments.documentId))
    .where(eq(payments.id, paymentId))
    .limit(1);
  if (!row)
    throw new PaymentError("payment_not_found");

  const applied = await tx
    .select({
      id: allocations.id,
      invoiceId: allocations.invoiceId,
      invoiceNumber: documents.number,
      amountCents: allocations.amountCents,
      allocatedAt: allocations.allocatedAt,
      reversedAt: allocations.reversedAt,
    })
    .from(allocations)
    .innerJoin(invoices, eq(invoices.id, allocations.invoiceId))
    .leftJoin(documents, eq(documents.id, invoices.documentId))
    .where(eq(allocations.paymentId, paymentId))
    .orderBy(asc(allocations.allocatedAt), asc(allocations.id));

  return {
    ...row.payment,
    receiptNumber: row.receiptNumber,
    unallocatedCents: row.payment.reversedAt ? 0 : await unallocatedCents(tx, row.payment),
    allocations: applied,
  };
}

export type PaymentDetail = Awaited<ReturnType<typeof paymentDetail>>;

/** Opens a payment: a read of a patient's money, audited (rule 9). */
export async function viewPayment(tx: AppDb, facilityId: string, paymentId: string, actor: PatientActor): Promise<PaymentDetail> {
  const detail = await paymentDetail(tx, paymentId);
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "payment.viewed",
    entityType: "payment",
    entityId: paymentId,
    summary: `Opened payment ${detail.receiptNumber}`,
  });
  return detail;
}

/**
 * A patient's account as the cashier sees it: credit not yet applied, and
 * every finalised bill with what it still owes. Opening it is audited (rule 9).
 */
export async function viewAccount(tx: AppDb, facilityId: string, patientId: string, actor: PatientActor) {
  const [patient] = await tx.select({ id: patients.id }).from(patients).where(eq(patients.id, patientId)).limit(1);
  if (!patient)
    throw new PaymentError("patient_not_found");

  const [account] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.patientId, patientId)).limit(1);
  const standing = account
    ? await tx.select().from(payments).where(and(eq(payments.accountId, account.id), isNull(payments.reversedAt))).orderBy(asc(payments.receivedAt))
    : [];
  const bills = account
    ? await tx
        .select({ invoice: invoices, number: documents.number })
        .from(invoices)
        .innerJoin(documents, eq(documents.id, invoices.documentId))
        .where(and(eq(invoices.accountId, account.id), eq(invoices.status, "finalised")))
        .orderBy(asc(invoices.finalisedAt))
    : [];

  let creditCents = 0;
  const credit = [];
  for (const payment of standing) {
    const freeCents = await unallocatedCents(tx, payment);
    creditCents += freeCents;
    if (freeCents > 0)
      credit.push({ paymentId: payment.id, encounterId: payment.encounterId, receivedAt: payment.receivedAt, unallocatedCents: freeCents });
  }
  const invoiceRows = [];
  for (const bill of bills)
    invoiceRows.push({ id: bill.invoice.id, number: bill.number, encounterId: bill.invoice.encounterId, totalCents: bill.invoice.totalCents!, balanceCents: await balanceCents(tx, bill.invoice) });

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "account.viewed",
    entityType: "patient",
    entityId: patientId,
    summary: "Opened a patient's account",
  });
  return {
    creditCents,
    owedCents: invoiceRows.reduce((sum, i) => sum + i.balanceCents, 0),
    credit,
    invoices: invoiceRows,
  };
}
