import { and, asc, eq, isNull, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { allocations, invoices, payments, refunds } from "@/db/schema";

import type { PatientActor } from "./patients";

import { recordAudit } from "./audit";
import { balanceCents } from "./invoice-balance";
import { formatKes } from "./money";

/**
 * Applying money to bills (SCHEMA.md §7.4), ported from school-saas-api's
 * allocations with the debtor account in the student's place.
 *
 * A payment lands as credit on its account; an allocation decides which
 * invoice it settles. Two invariants span rows: a payment's live
 * allocations and live refunds never exceed it (M2), and an invoice's live
 * allocations and approved adjustments never exceed its total (M3). Both are checked under
 * the payment's lock and then the invoice's (lock order M8), and a trigger
 * checks them again. "Live" is derived: neither the allocation nor its
 * payment is reversed.
 */

type PaymentRow = typeof payments.$inferSelect;
type InvoiceRow = typeof invoices.$inferSelect;
type AllocationRow = typeof allocations.$inferSelect;

export class AllocationError extends Error {
  constructor(readonly code:
    | "payment_not_found"
    | "payment_reversed"
    | "invoice_not_found"
    | "not_finalised"
    | "other_account"
    | "nothing_to_allocate"
    | "exceeds_payment"
    | "exceeds_invoice"
    | "allocation_not_found"
    | "already_reversed") {
    super({
      payment_not_found: "No such payment",
      payment_reversed: "This payment has been reversed",
      invoice_not_found: "No such invoice",
      not_finalised: "Only a finalised invoice is settled",
      other_account: "That invoice is someone else's",
      nothing_to_allocate: "Nothing is left on the payment, or owed on the invoice",
      exceeds_payment: "That is more than is left on the payment",
      exceeds_invoice: "That is more than is owed on the invoice",
      allocation_not_found: "No such allocation",
      already_reversed: "This allocation is already reversed",
    }[code]);
    this.name = "AllocationError";
  }
}

/**
 * What is left of a payment to allocate or refund: its amount less its live
 * allocations and live refunds (M2). A refund is live from approval until
 * it is reversed.
 */
export async function unallocatedCents(tx: AppDb, payment: { id: string; amountCents: number }): Promise<number> {
  const [allocated] = await tx
    .select({ cents: sql<number>`coalesce(sum(${allocations.amountCents}), 0)`.mapWith(Number) })
    .from(allocations)
    .where(and(eq(allocations.paymentId, payment.id), isNull(allocations.reversedAt)));
  const [refunded] = await tx
    .select({ cents: sql<number>`coalesce(sum(${refunds.amountCents}), 0)`.mapWith(Number) })
    .from(refunds)
    .where(and(eq(refunds.paymentId, payment.id), eq(refunds.status, "approved"), isNull(refunds.reversedAt)));
  return payment.amountCents - allocated.cents - refunded.cents;
}

async function lockPayment(tx: AppDb, paymentId: string): Promise<PaymentRow> {
  const [payment] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for("update").limit(1);
  if (!payment)
    throw new AllocationError("payment_not_found");
  if (payment.reversedAt)
    throw new AllocationError("payment_reversed");
  return payment;
}

async function lockInvoice(tx: AppDb, invoiceId: string, accountId: string): Promise<InvoiceRow> {
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update").limit(1);
  if (!invoice)
    throw new AllocationError("invoice_not_found");
  if (invoice.status !== "finalised")
    throw new AllocationError("not_finalised");
  // Unstorable anyway (M1's foreign keys); refused here with a plain answer.
  if (invoice.accountId !== accountId)
    throw new AllocationError("other_account");
  return invoice;
}

/**
 * Allocates part of a payment to an invoice: `amountCents`, or by default
 * as much as both have left.
 */
export async function allocate(
  tx: AppDb,
  facilityId: string,
  input: { paymentId: string; invoiceId: string; amountCents?: number },
  actor: PatientActor | null,
): Promise<{ id: string; amountCents: number }> {
  const payment = await lockPayment(tx, input.paymentId);
  const invoice = await lockInvoice(tx, input.invoiceId, payment.accountId);

  const free = await unallocatedCents(tx, payment);
  const owed = await balanceCents(tx, invoice);
  const amountCents = input.amountCents ?? Math.min(free, owed);
  if (amountCents <= 0)
    throw new AllocationError("nothing_to_allocate");
  if (amountCents > free)
    throw new AllocationError("exceeds_payment");
  if (amountCents > owed)
    throw new AllocationError("exceeds_invoice");

  const [allocation] = await tx.insert(allocations).values({
    facilityId,
    paymentId: payment.id,
    invoiceId: invoice.id,
    accountId: payment.accountId,
    amountCents,
    allocatedBy: actor?.membershipId ?? null,
  }).returning({ id: allocations.id });

  await recordAudit(tx, {
    facilityId,
    actorId: actor?.userId ?? null,
    action: "allocation.recorded",
    entityType: "allocation",
    entityId: allocation.id,
    summary: `Applied ${formatKes(amountCents)} of a payment to an invoice`,
    detail: { paymentId: payment.id, invoiceId: invoice.id, amountCents },
  });
  return { id: allocation.id, amountCents };
}

/**
 * Locks the credit paid towards an encounter on one account: standing
 * payments tagged to it, oldest first, then by id. Called before the
 * invoice's lock (M8: payments before invoices).
 */
export async function lockEncounterCredit(tx: AppDb, encounterId: string, accountId: string): Promise<{ id: string; freeCents: number }[]> {
  const rows = await tx
    .select({ id: payments.id, amountCents: payments.amountCents })
    .from(payments)
    .where(and(eq(payments.encounterId, encounterId), eq(payments.accountId, accountId), isNull(payments.reversedAt)))
    .orderBy(asc(payments.receivedAt), asc(payments.id))
    .for("update");

  const credit: { id: string; freeCents: number }[] = [];
  for (const row of rows) {
    const freeCents = await unallocatedCents(tx, row);
    if (freeCents > 0)
      credit.push({ id: row.id, freeCents });
  }
  return credit;
}

/**
 * Applies locked credit to an invoice just finalised, oldest payment first,
 * up to its total (decided 2026-11-04: a deposit settles its admission's
 * bill without anyone asking). Returns what was applied.
 */
export async function applyCredit(
  tx: AppDb,
  facilityId: string,
  credit: { id: string; freeCents: number }[],
  invoice: { id: string; accountId: string; totalCents: number },
  actor: PatientActor,
): Promise<number> {
  let owed = invoice.totalCents;
  let applied = 0;
  const used: string[] = [];
  for (const payment of credit) {
    const amountCents = Math.min(payment.freeCents, owed);
    if (amountCents <= 0)
      break;
    await tx.insert(allocations).values({
      facilityId,
      paymentId: payment.id,
      invoiceId: invoice.id,
      accountId: invoice.accountId,
      amountCents,
      allocatedBy: actor.membershipId,
    });
    owed -= amountCents;
    applied += amountCents;
    used.push(payment.id);
  }

  if (applied > 0) {
    await recordAudit(tx, {
      facilityId,
      actorId: actor.userId,
      action: "allocation.recorded",
      entityType: "invoice",
      entityId: invoice.id,
      summary: `Applied ${formatKes(applied)} of credit to an invoice on finalising it`,
      detail: { invoiceId: invoice.id, amountCents: applied, payments: used },
    });
  }
  return applied;
}

/**
 * Un-applies an allocation; its money returns to the payment's credit. On a
 * reversed payment the allocation already counts for nothing, and there is
 * no credit to return.
 */
export async function reverseAllocation(tx: AppDb, facilityId: string, id: string, reason: string, actor: PatientActor): Promise<AllocationRow> {
  const [allocation] = await tx.select().from(allocations).where(eq(allocations.id, id)).for("update").limit(1);
  if (!allocation)
    throw new AllocationError("allocation_not_found");
  if (allocation.reversedAt)
    throw new AllocationError("already_reversed");

  const [reversed] = await tx.update(allocations)
    .set({ reversedAt: new Date(), reversedBy: actor.membershipId, reversalReason: reason })
    .where(eq(allocations.id, id))
    .returning();

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "allocation.reversed",
    entityType: "allocation",
    entityId: id,
    summary: `Reversed an allocation of ${formatKes(allocation.amountCents)}: ${reason}`,
    detail: { paymentId: allocation.paymentId, invoiceId: allocation.invoiceId, reason },
  });
  return reversed;
}
