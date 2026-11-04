import { and, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { AppDb } from "@/db";

import { documents, encounters, invoiceAdjustments, invoices } from "@/db/schema";

import type { PrintedContent } from "./document-content";
import type { PatientActor } from "./patients";

import { recordAudit } from "./audit";
import { billedFields } from "./billing";
import { issueDocument } from "./documents";
import { balanceCents } from "./invoice-balance";
import { formatKes } from "./money";

/**
 * Invoice adjustments (SCHEMA.md §7.5): credit notes, waivers and write-offs
 * against a finalised invoice. One person asks, a finance manager or the
 * facility admin approves, and never the same person (rule 24).
 *
 * Approving takes the invoice's lock before the adjustment's, so two
 * approvals on one invoice queue and M3 holds: approved adjustments and
 * allocations never exceed the total. An approved credit note
 * is a numbered fiscal document, issued in the approving transaction.
 */

type AdjustmentRow = typeof invoiceAdjustments.$inferSelect;
export type AdjustmentKind = AdjustmentRow["kind"];
export type AdjustmentStatus = AdjustmentRow["status"];

export class AdjustmentError extends Error {
  constructor(readonly code:
    | "invoice_not_found"
    | "not_finalised"
    | "exceeds_balance"
    | "not_found"
    | "not_pending"
    | "same_person"
    | "not_requester") {
    super({
      invoice_not_found: "No such invoice",
      not_finalised: "Only a finalised invoice is adjusted",
      exceeds_balance: "That is more than is left on the invoice",
      not_found: "No such adjustment",
      not_pending: "This adjustment has already been decided",
      same_person: "Someone other than the requester must decide this",
      not_requester: "Only the person who asked can withdraw it",
    }[code]);
    this.name = "AdjustmentError";
  }
}

const LABELS: Record<AdjustmentKind, string> = {
  credit_note: "Credit note",
  waiver: "Waiver",
  write_off: "Write-off",
};

/** What is left on an invoice for an adjustment: its total less approved adjustments and live allocations (M3). */
async function roomOn(tx: AppDb, invoice: typeof invoices.$inferSelect): Promise<number> {
  return balanceCents(tx, invoice);
}

/** Asks for an amount to come off a finalised invoice. */
export async function requestAdjustment(
  tx: AppDb,
  facilityId: string,
  input: { invoiceId: string; kind: AdjustmentKind; amountCents: number; reason: string },
  actor: PatientActor,
): Promise<string> {
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1);
  if (!invoice)
    throw new AdjustmentError("invoice_not_found");
  if (invoice.status !== "finalised")
    throw new AdjustmentError("not_finalised");
  // A first look; approval checks again under the invoice's lock.
  if (input.amountCents > await roomOn(tx, invoice))
    throw new AdjustmentError("exceeds_balance");

  const [adjustment] = await tx.insert(invoiceAdjustments).values({
    facilityId,
    invoiceId: invoice.id,
    accountId: invoice.accountId,
    kind: input.kind,
    amountCents: input.amountCents,
    reason: input.reason,
    requestedBy: actor.membershipId,
  }).returning({ id: invoiceAdjustments.id });

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "adjustment.requested",
    entityType: "invoice_adjustment",
    entityId: adjustment.id,
    summary: `Asked for a ${LABELS[input.kind].toLowerCase()} of ${formatKes(input.amountCents)}`,
    detail: { invoiceId: invoice.id, kind: input.kind, amountCents: input.amountCents, reason: input.reason },
  });
  return adjustment.id;
}

async function lockPending(tx: AppDb, id: string): Promise<AdjustmentRow> {
  const [adjustment] = await tx.select().from(invoiceAdjustments).where(eq(invoiceAdjustments.id, id)).for("update").limit(1);
  if (!adjustment)
    throw new AdjustmentError("not_found");
  if (adjustment.status !== "pending")
    throw new AdjustmentError("not_pending");
  return adjustment;
}

/** What an approved credit note prints, frozen when it is issued (rule 7). */
async function printedCreditNote(tx: AppDb, invoice: typeof invoices.$inferSelect, adjustment: AdjustmentRow): Promise<PrintedContent> {
  const [encounter] = await tx.select({ patientId: encounters.patientId }).from(encounters).where(eq(encounters.id, invoice.encounterId)).limit(1);
  const [invoiceDocument] = await tx.select({ number: documents.number }).from(documents).where(eq(documents.id, invoice.documentId!)).limit(1);

  return {
    title: "Credit note",
    fields: [
      ...await billedFields(tx, invoice.accountId, encounter.patientId),
      { label: "Against invoice", value: invoiceDocument.number },
      { label: "Reason", value: adjustment.reason },
    ],
    totals: [
      { label: "Invoice total", value: formatKes(invoice.totalCents ?? 0) },
      { label: "Credited", value: formatKes(adjustment.amountCents) },
    ],
  };
}

/** Approves an adjustment, by someone other than the requester. A credit note takes its number now. */
export async function approveAdjustment(tx: AppDb, facilityId: string, id: string, actor: PatientActor, at = new Date()) {
  const [found] = await tx.select({ invoiceId: invoiceAdjustments.invoiceId }).from(invoiceAdjustments).where(eq(invoiceAdjustments.id, id)).limit(1);
  if (!found)
    throw new AdjustmentError("not_found");
  // The invoice's lock first, then the adjustment's.
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, found.invoiceId)).for("update").limit(1);
  const adjustment = await lockPending(tx, id);
  if (adjustment.requestedBy === actor.membershipId)
    throw new AdjustmentError("same_person");
  if (invoice.status !== "finalised")
    throw new AdjustmentError("not_finalised");
  if (adjustment.amountCents > await roomOn(tx, invoice))
    throw new AdjustmentError("exceeds_balance");

  const document = adjustment.kind === "credit_note"
    ? await issueDocument(tx, { facilityId, kind: "credit_note", content: await printedCreditNote(tx, invoice, adjustment), issuedBy: actor, at })
    : null;

  await tx.update(invoiceAdjustments)
    .set({ status: "approved", decidedBy: actor.membershipId, decidedAt: at, documentId: document?.id ?? null })
    .where(eq(invoiceAdjustments.id, id));

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "adjustment.approved",
    entityType: "invoice_adjustment",
    entityId: id,
    summary: `Approved a ${LABELS[adjustment.kind].toLowerCase()} of ${formatKes(adjustment.amountCents)}${document ? ` (${document.number})` : ""}`,
    detail: { invoiceId: invoice.id, kind: adjustment.kind, amountCents: adjustment.amountCents, number: document?.number ?? null },
  });
  return { number: document?.number ?? null };
}

export async function rejectAdjustment(tx: AppDb, facilityId: string, id: string, actor: PatientActor) {
  const adjustment = await lockPending(tx, id);
  if (adjustment.requestedBy === actor.membershipId)
    throw new AdjustmentError("same_person");

  await tx.update(invoiceAdjustments).set({ status: "rejected", decidedBy: actor.membershipId, decidedAt: new Date() }).where(eq(invoiceAdjustments.id, id));
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "adjustment.rejected",
    entityType: "invoice_adjustment",
    entityId: id,
    summary: `Rejected a ${LABELS[adjustment.kind].toLowerCase()} of ${formatKes(adjustment.amountCents)}`,
    detail: { invoiceId: adjustment.invoiceId },
  });
}

export async function withdrawAdjustment(tx: AppDb, facilityId: string, id: string, actor: PatientActor) {
  const adjustment = await lockPending(tx, id);
  if (adjustment.requestedBy !== actor.membershipId)
    throw new AdjustmentError("not_requester");

  await tx.update(invoiceAdjustments).set({ status: "withdrawn", decidedBy: actor.membershipId, decidedAt: new Date() }).where(eq(invoiceAdjustments.id, id));
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "adjustment.withdrawn",
    entityType: "invoice_adjustment",
    entityId: id,
    summary: `Withdrew a ${LABELS[adjustment.kind].toLowerCase()} of ${formatKes(adjustment.amountCents)}`,
    detail: { invoiceId: adjustment.invoiceId },
  });
}

/** Adjustments, newest first: the approver's queue when filtered to `pending`. Names no patient. */
export async function listAdjustments(tx: AppDb, filter: { status?: AdjustmentStatus; id?: string } = {}) {
  const invoiceDocument = alias(documents, "invoice_document");
  return tx
    .select({
      id: invoiceAdjustments.id,
      invoiceId: invoiceAdjustments.invoiceId,
      invoiceNumber: invoiceDocument.number,
      /** An approved credit note's own number. */
      number: documents.number,
      kind: invoiceAdjustments.kind,
      amountCents: invoiceAdjustments.amountCents,
      reason: invoiceAdjustments.reason,
      status: invoiceAdjustments.status,
      requestedBy: invoiceAdjustments.requestedBy,
      requestedAt: invoiceAdjustments.requestedAt,
      decidedBy: invoiceAdjustments.decidedBy,
      decidedAt: invoiceAdjustments.decidedAt,
    })
    .from(invoiceAdjustments)
    .innerJoin(invoices, eq(invoices.id, invoiceAdjustments.invoiceId))
    .leftJoin(invoiceDocument, eq(invoiceDocument.id, invoices.documentId))
    .leftJoin(documents, eq(documents.id, invoiceAdjustments.documentId))
    .where(and(
      filter.status ? eq(invoiceAdjustments.status, filter.status) : undefined,
      filter.id ? eq(invoiceAdjustments.id, filter.id) : undefined,
    ))
    .orderBy(desc(invoiceAdjustments.requestedAt), desc(invoiceAdjustments.id))
    .limit(100);
}
