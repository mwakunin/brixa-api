import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { AppDb } from "@/db";

import {
  accounts,
  admissions,
  billableItems,
  chargeAssignments,
  charges,
  documents,
  encounters,
  invoiceAdjustments,
  invoiceLines,
  invoices,
  patientNumbers,
  patients,
  payers,
} from "@/db/schema";

import type { PrintedContent } from "./document-content";
import type { PatientActor } from "./patients";

import { recordAudit } from "./audit";
import { businessDate, printedDate } from "./dates";
import { issueDocument, voidDocument } from "./documents";
import { formatKes, printedQuantity } from "./money";

/**
 * Accounts and invoices (SCHEMA.md §7.1, §7.3): who is asked to pay which
 * part of an encounter.
 *
 * A draft invoice assigns charges, or parts of them, to one account; the
 * assignment is what the bill asks for. A charge is never assigned beyond its
 * amount (M4), and a final invoice is finalised only once every standing
 * charge of the encounter is fully assigned. Finalising freezes the total and
 * issues the numbered document in the same transaction (rule 20).
 *
 * Lock order M8, in every function here: the encounter, then its charges by
 * id, then the invoice.
 */

type InvoiceRow = typeof invoices.$inferSelect;
type EncounterRow = typeof encounters.$inferSelect;
export type InvoiceKind = InvoiceRow["kind"];

export class BillingError extends Error {
  constructor(readonly code:
    | "encounter_not_found"
    | "encounter_cancelled"
    | "final_exists"
    | "no_final"
    | "nothing_to_bill"
    | "portion_invalid"
    | "invoice_not_found"
    | "not_draft"
    | "already_void"
    | "charges_unbilled"
    | "other_patient"
    | "void_needs_finance"
    | "has_adjustments") {
    super({
      encounter_not_found: "No such encounter",
      encounter_cancelled: "A cancelled encounter is not billed",
      final_exists: "This account already has a final invoice for the encounter; bill later charges on a supplementary invoice",
      no_final: "A supplementary invoice follows a finalised final invoice",
      nothing_to_bill: "Every charge on this encounter is already billed",
      portion_invalid: "Each portion must be whole shillings, of a standing charge, within what is left of it",
      invoice_not_found: "No such invoice",
      not_draft: "Only a draft invoice can be finalised",
      already_void: "This invoice is already voided",
      charges_unbilled: "Some charges are not on any bill yet; void this draft and draft it again",
      other_patient: "That is another patient's account",
      void_needs_finance: "Only a finance manager or the facility admin voids a finalised invoice",
      has_adjustments: "This invoice has approved adjustments; it stands as adjusted",
    }[code]);
    this.name = "BillingError";
  }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/** Whose account: a patient's, or a payer's. */
export type AccountOwner = { patientId: string } | { payerId: string };

/** The owner's account, created the first time it is billed. */
export async function ensureAccount(tx: AppDb, facilityId: string, owner: AccountOwner): Promise<string> {
  if ("patientId" in owner) {
    await tx.insert(accounts)
      .values({ facilityId, kind: "patient", patientId: owner.patientId })
      .onConflictDoNothing({ target: [accounts.facilityId, accounts.patientId] });
  }
  else {
    await tx.insert(accounts)
      .values({ facilityId, kind: "payer", payerId: owner.payerId })
      .onConflictDoNothing({ target: [accounts.facilityId, accounts.payerId] });
  }

  const [row] = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where("patientId" in owner ? eq(accounts.patientId, owner.patientId) : eq(accounts.payerId, owner.payerId))
    .limit(1);
  return row.id;
}

// ---------------------------------------------------------------------------
// Charges as the bill sees them
// ---------------------------------------------------------------------------

interface LiveCharge {
  id: string;
  code: string;
  name: string;
  quantity: string;
  unitPriceCents: number;
  amountCents: number;
  serviceDate: string;
  /** What no live invoice asks for yet. */
  remainingCents: number;
}

/** Σ live assignments of each charge: those on an invoice that is not void. */
export async function assignedByCharge(tx: AppDb, chargeIds: string[]): Promise<Map<string, number>> {
  if (chargeIds.length === 0)
    return new Map();

  const rows = await tx
    .select({
      chargeId: chargeAssignments.chargeId,
      cents: sql<number>`sum(${chargeAssignments.amountCents})`.mapWith(Number),
    })
    .from(chargeAssignments)
    .innerJoin(invoiceLines, eq(invoiceLines.id, chargeAssignments.invoiceLineId))
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(and(inArray(chargeAssignments.chargeId, chargeIds), ne(invoices.status, "void")))
    .groupBy(chargeAssignments.chargeId);
  return new Map(rows.map(r => [r.chargeId, r.cents]));
}

async function lockEncounter(tx: AppDb, encounterId: string): Promise<EncounterRow> {
  const [encounter] = await tx.select().from(encounters).where(eq(encounters.id, encounterId)).for("update").limit(1);
  if (!encounter)
    throw new BillingError("encounter_not_found");
  return encounter;
}

/** The encounter's standing charges, locked in id order (M8). */
async function lockLiveCharges(tx: AppDb, encounterId: string): Promise<LiveCharge[]> {
  const rows = await tx
    .select({
      id: charges.id,
      code: billableItems.code,
      name: billableItems.name,
      quantity: charges.quantity,
      unitPriceCents: charges.unitPriceCents,
      amountCents: charges.amountCents,
      serviceDate: charges.serviceDate,
    })
    .from(charges)
    .innerJoin(billableItems, eq(billableItems.id, charges.billableItemId))
    .where(and(eq(charges.encounterId, encounterId), isNull(charges.cancelledAt)))
    .orderBy(asc(charges.id))
    .for("update", { of: charges });

  const assigned = await assignedByCharge(tx, rows.map(r => r.id));
  return rows.map(r => ({ ...r, remainingCents: r.amountCents - (assigned.get(r.id) ?? 0) }));
}

/** What a draft asks for: the given portions, or everything not yet billed. */
function billablePortions(live: LiveCharge[], portions?: ReadonlyMap<string, number>) {
  if (!portions)
    return live.filter(c => c.remainingCents > 0).map(charge => ({ charge, cents: charge.remainingCents }));

  const byId = new Map(live.map(c => [c.id, c]));
  return [...portions].map(([chargeId, cents]) => {
    const charge = byId.get(chargeId);
    if (!charge || !Number.isSafeInteger(cents) || cents <= 0 || cents % 100 !== 0 || cents > charge.remainingCents)
      throw new BillingError("portion_invalid");
    return { charge, cents };
  });
}

// ---------------------------------------------------------------------------
// Drafting, finalising and voiding
// ---------------------------------------------------------------------------

/** One live final invoice per encounter and account; a supplementary one follows it. */
async function checkKind(tx: AppDb, encounterId: string, accountId: string, kind: InvoiceKind) {
  const [final] = await tx
    .select({ status: invoices.status })
    .from(invoices)
    .where(and(
      eq(invoices.encounterId, encounterId),
      eq(invoices.accountId, accountId),
      eq(invoices.kind, "final"),
      ne(invoices.status, "void"),
    ))
    .limit(1);

  if (kind === "supplementary") {
    if (final?.status !== "finalised")
      throw new BillingError("no_final");
  }
  else if (final) {
    throw new BillingError("final_exists");
  }
}

/**
 * Drafts an invoice for one account: by default the encounter's patient,
 * for every standing charge not yet on a live invoice. `portions` (charge
 * id → cents) bills only part of some charges, for a payer split; the API
 * does not offer it until payers have their own price lists (P7, rule 21).
 */
export async function draftInvoice(
  tx: AppDb,
  facilityId: string,
  input: { encounterId: string; kind: InvoiceKind; owner?: AccountOwner; portions?: ReadonlyMap<string, number> },
  actor: PatientActor,
): Promise<string> {
  const encounter = await lockEncounter(tx, input.encounterId);
  if (encounter.status === "cancelled")
    throw new BillingError("encounter_cancelled");

  // A patient pays for their own encounter; any other patient is the wrong account.
  if (input.owner && "patientId" in input.owner && input.owner.patientId !== encounter.patientId)
    throw new BillingError("other_patient");
  const accountId = await ensureAccount(tx, facilityId, input.owner ?? { patientId: encounter.patientId });
  await checkKind(tx, encounter.id, accountId, input.kind);

  const portions = billablePortions(await lockLiveCharges(tx, encounter.id), input.portions);
  if (portions.length === 0)
    throw new BillingError("nothing_to_bill");

  const [invoice] = await tx.insert(invoices).values({
    facilityId,
    accountId,
    encounterId: encounter.id,
    kind: input.kind,
    createdBy: actor.membershipId,
  }).returning({ id: invoices.id });

  // Ids made here, so each assignment names its own line without relying on
  // the order RETURNING gives rows back in.
  const lines = portions.map(p => ({ ...p, lineId: randomUUID() }));
  await tx.insert(invoiceLines).values(lines.map(({ charge, cents, lineId }) => ({
    id: lineId,
    facilityId,
    invoiceId: invoice.id,
    accountId,
    kind: "itemised" as const,
    code: charge.code,
    description: charge.name,
    quantity: charge.quantity,
    unitPriceCents: charge.unitPriceCents,
    amountCents: cents,
    serviceDate: charge.serviceDate,
  })));
  await tx.insert(chargeAssignments).values(lines.map(({ charge, cents, lineId }) => ({
    facilityId,
    chargeId: charge.id,
    invoiceLineId: lineId,
    accountId,
    amountCents: cents,
    mode: "itemised" as const,
  })));

  const amountCents = lines.reduce((sum, l) => sum + l.cents, 0);
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "invoice.drafted",
    entityType: "invoice",
    entityId: invoice.id,
    summary: `Drafted a ${input.kind} invoice for ${formatKes(amountCents)}`,
    detail: { encounterId: encounter.id, accountId, kind: input.kind, lines: lines.length, amountCents },
  });
  return invoice.id;
}

async function invoiceById(tx: AppDb, invoiceId: string, lock = false): Promise<InvoiceRow> {
  const query = tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  const [invoice] = lock ? await query.for("update") : await query;
  if (!invoice)
    throw new BillingError("invoice_not_found");
  return invoice;
}

async function linesOf(tx: AppDb, invoiceId: string) {
  return tx
    .select({
      code: invoiceLines.code,
      description: invoiceLines.description,
      quantity: invoiceLines.quantity,
      unitPriceCents: invoiceLines.unitPriceCents,
      amountCents: invoiceLines.amountCents,
      serviceDate: invoiceLines.serviceDate,
    })
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, invoiceId))
    .orderBy(asc(invoiceLines.serviceDate), asc(invoiceLines.code), asc(invoiceLines.id));
}

type Line = Awaited<ReturnType<typeof linesOf>>[number];

/**
 * Finalises a draft: freezes its total and issues its number and printed
 * document. A final invoice needs every standing charge of the encounter on
 * a live invoice (M4), so nothing done for the patient goes unbilled.
 */
export async function finaliseInvoice(tx: AppDb, facilityId: string, invoiceId: string, actor: PatientActor, at = new Date()) {
  const { encounterId } = await invoiceById(tx, invoiceId);
  const encounter = await lockEncounter(tx, encounterId);
  const live = await lockLiveCharges(tx, encounterId);
  const invoice = await invoiceById(tx, invoiceId, true);
  if (invoice.status !== "draft")
    throw new BillingError("not_draft");
  if (invoice.kind === "final" && live.some(c => c.remainingCents > 0))
    throw new BillingError("charges_unbilled");

  const lines = await linesOf(tx, invoice.id);
  const totalCents = lines.reduce((sum, l) => sum + l.amountCents, 0);
  const document = await issueDocument(tx, {
    facilityId,
    kind: "invoice",
    content: await printedInvoice(tx, invoice, encounter, lines, totalCents),
    issuedBy: actor,
    at,
  });

  const [finalised] = await tx.update(invoices)
    .set({ status: "finalised", totalCents, documentId: document.id, finalisedAt: at, finalisedBy: actor.membershipId })
    .where(eq(invoices.id, invoice.id))
    .returning();

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "invoice.finalised",
    entityType: "invoice",
    entityId: invoice.id,
    summary: `Finalised invoice ${document.number} for ${formatKes(totalCents)}`,
    detail: { encounterId, number: document.number, totalCents },
  });
  return { invoice: finalised, number: document.number };
}

/**
 * Voids an invoice, releasing its charges to be billed again. A finalised
 * one keeps its number, and its document is voided with it; only finance
 * may void one (`mayVoidFinalised`), and not while an approved adjustment
 * stands against it. Slice 5 adds: nor while money is allocated to it.
 */
export async function voidInvoice(
  tx: AppDb,
  facilityId: string,
  input: { invoiceId: string; reason: string; mayVoidFinalised: boolean },
  actor: PatientActor,
  at = new Date(),
) {
  const { encounterId } = await invoiceById(tx, input.invoiceId);
  await lockEncounter(tx, encounterId);
  const invoice = await invoiceById(tx, input.invoiceId, true);
  if (invoice.status === "void")
    throw new BillingError("already_void");
  if (invoice.status === "finalised" && !input.mayVoidFinalised)
    throw new BillingError("void_needs_finance");
  if (await adjustedCents(tx, invoice.id) > 0)
    throw new BillingError("has_adjustments");

  if (invoice.documentId)
    await voidDocument(tx, { facilityId, documentId: invoice.documentId, reason: input.reason, voidedBy: actor, at });

  const [voided] = await tx.update(invoices)
    .set({ status: "void", voidedAt: at, voidedBy: actor.membershipId, voidReason: input.reason })
    .where(eq(invoices.id, invoice.id))
    .returning();

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "invoice.voided",
    entityType: "invoice",
    entityId: invoice.id,
    summary: `Voided a ${invoice.status} invoice: ${input.reason}`,
    detail: { encounterId, wasStatus: invoice.status, reason: input.reason },
  });
  return voided;
}

// ---------------------------------------------------------------------------
// The printed invoice
// ---------------------------------------------------------------------------

const TITLES: Record<InvoiceKind, string> = {
  interim: "Interim invoice",
  final: "Invoice",
  supplementary: "Supplementary invoice",
};

async function visitLine(tx: AppDb, encounter: EncounterRow): Promise<string> {
  const started = printedDate(businessDate(encounter.startedAt));
  if (encounter.kind === "opd")
    return `Outpatient visit, ${started}`;
  if (encounter.kind === "emergency")
    return `Emergency attendance, ${started}`;

  const [admission] = await tx
    .select({ number: admissions.admissionNumber })
    .from(admissions)
    .where(eq(admissions.encounterId, encounter.id))
    .limit(1);
  const ended = encounter.endedAt ? printedDate(businessDate(encounter.endedAt)) : "still admitted";
  return `${admission ? `Admission ${admission.number}` : "Admission"}, ${started} to ${ended}`;
}

/**
 * Who a bill is for, as printed: the account billed and, for a payer, the
 * patient too. Shared by the invoice and its credit notes.
 */
export async function billedFields(tx: AppDb, accountId: string, patientId: string): Promise<{ label: string; value: string }[]> {
  const [patient] = await tx
    .select({ givenName: patients.givenName, middleNames: patients.middleNames, familyName: patients.familyName })
    .from(patients)
    .where(eq(patients.id, patientId))
    .limit(1);
  const [opNumber] = await tx
    .select({ number: patientNumbers.number })
    .from(patientNumbers)
    .where(and(eq(patientNumbers.patientId, patientId), eq(patientNumbers.kind, "outpatient")))
    .limit(1);
  const [account] = await tx
    .select({ payerName: payers.name })
    .from(accounts)
    .leftJoin(payers, eq(payers.id, accounts.payerId))
    .where(eq(accounts.id, accountId))
    .limit(1);

  const patientName = [patient.givenName, patient.middleNames, patient.familyName].filter(Boolean).join(" ");
  return [
    { label: "Bill to", value: account.payerName ?? patientName },
    ...(account.payerName ? [{ label: "Patient", value: patientName }] : []),
    { label: "Patient number", value: opNumber?.number ?? "" },
  ];
}

/** What the invoice prints, frozen at finalisation (rule 7). */
async function printedInvoice(
  tx: AppDb,
  invoice: InvoiceRow,
  encounter: EncounterRow,
  lines: Line[],
  totalCents: number,
): Promise<PrintedContent> {
  return {
    title: TITLES[invoice.kind],
    fields: [
      ...await billedFields(tx, invoice.accountId, encounter.patientId),
      { label: "Visit", value: await visitLine(tx, encounter) },
    ],
    table: {
      columns: [
        { label: "Date" },
        { label: "Code" },
        { label: "Description" },
        { label: "Qty", align: "right" },
        { label: "Unit price", align: "right" },
        { label: "Amount", align: "right" },
      ],
      rows: lines.map(l => [
        printedDate(l.serviceDate),
        l.code,
        l.description,
        printedQuantity(l.quantity),
        formatKes(l.unitPriceCents),
        formatKes(l.amountCents),
      ]),
    },
    totals: [{ label: "Total", value: formatKes(totalCents) }],
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** One invoice with its lines. A draft's total is its lines' sum; a bill's balance is derived (rule 4). */
export async function invoiceDetail(tx: AppDb, invoiceId: string) {
  const [row] = await tx
    .select({ invoice: invoices, number: documents.number, accountKind: accounts.kind, payerName: payers.name })
    .from(invoices)
    .innerJoin(accounts, eq(accounts.id, invoices.accountId))
    .leftJoin(payers, eq(payers.id, accounts.payerId))
    .leftJoin(documents, eq(documents.id, invoices.documentId))
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  if (!row)
    throw new BillingError("invoice_not_found");

  const lines = await linesOf(tx, invoiceId);
  const adjustments = await tx
    .select({
      id: invoiceAdjustments.id,
      kind: invoiceAdjustments.kind,
      amountCents: invoiceAdjustments.amountCents,
      reason: invoiceAdjustments.reason,
      status: invoiceAdjustments.status,
      number: documents.number,
      requestedAt: invoiceAdjustments.requestedAt,
      decidedAt: invoiceAdjustments.decidedAt,
    })
    .from(invoiceAdjustments)
    .leftJoin(documents, eq(documents.id, invoiceAdjustments.documentId))
    .where(eq(invoiceAdjustments.invoiceId, invoiceId))
    .orderBy(asc(invoiceAdjustments.requestedAt), asc(invoiceAdjustments.id));

  const totalCents = row.invoice.totalCents ?? lines.reduce((sum, l) => sum + l.amountCents, 0);
  const adjustedCents = adjustments.filter(a => a.status === "approved").reduce((sum, a) => sum + a.amountCents, 0);
  return {
    ...row.invoice,
    number: row.number,
    accountKind: row.accountKind,
    payerName: row.payerName,
    totalCents,
    // Slice 5 subtracts live allocations too.
    balanceCents: row.invoice.status === "finalised" ? totalCents - adjustedCents : null,
    lines,
    adjustments,
  };
}

/** Σ approved adjustments of an invoice: what M3 counts besides allocations. */
export async function adjustedCents(tx: AppDb, invoiceId: string): Promise<number> {
  const [row] = await tx
    .select({ cents: sql<number>`coalesce(sum(${invoiceAdjustments.amountCents}), 0)`.mapWith(Number) })
    .from(invoiceAdjustments)
    .where(and(eq(invoiceAdjustments.invoiceId, invoiceId), eq(invoiceAdjustments.status, "approved")));
  return row.cents;
}

export type InvoiceDetail = Awaited<ReturnType<typeof invoiceDetail>>;

/** Opens an invoice: a read of what was done for the patient, audited (rule 9). */
export async function viewInvoice(tx: AppDb, facilityId: string, invoiceId: string, actor: PatientActor): Promise<InvoiceDetail> {
  const detail = await invoiceDetail(tx, invoiceId);
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "invoice.viewed",
    entityType: "invoice",
    entityId: invoiceId,
    summary: "Opened an invoice",
    detail: { encounterId: detail.encounterId },
  });
  return detail;
}

/** An encounter's invoices, oldest first. A draft's total is its lines' sum. */
export async function listInvoices(tx: AppDb, encounterId: string) {
  return tx
    .select({
      id: invoices.id,
      kind: invoices.kind,
      status: invoices.status,
      number: documents.number,
      accountKind: accounts.kind,
      payerName: payers.name,
      totalCents: sql<number>`coalesce(${invoices.totalCents}, (
        SELECT sum(${invoiceLines.amountCents}) FROM ${invoiceLines} WHERE ${invoiceLines.invoiceId} = ${invoices.id}
      ))`.mapWith(Number),
      createdAt: invoices.createdAt,
      finalisedAt: invoices.finalisedAt,
      voidedAt: invoices.voidedAt,
    })
    .from(invoices)
    .innerJoin(accounts, eq(accounts.id, invoices.accountId))
    .leftJoin(payers, eq(payers.id, accounts.payerId))
    .leftJoin(documents, eq(documents.id, invoices.documentId))
    .where(eq(invoices.encounterId, encounterId))
    .orderBy(asc(invoices.createdAt), asc(invoices.id));
}
