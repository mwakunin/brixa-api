import type { AnyColumn } from "drizzle-orm";

import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { accounts, admissions, documents, encounters, gatewayExchanges, invoices, mpesaSettings, mpesaTransactions, patientNumbers, payments } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import env from "@/env";

import type { DarajaCredentials, Exchange } from "./daraja";
import type { PatientActor } from "./patients";
import type { PaymentMethod } from "./payments";

import { recordAudit } from "./audit";
import { decryptSecret, encryptSecret, generateCallbackToken } from "./crypto";
import { exchangeOf, registerC2bUrls } from "./daraja";
import { errorLine } from "./error-summary";
import { enqueue } from "./outbox";
import { PaymentError, recordPayment } from "./payments";

/**
 * M-Pesa (SCHEMA.md §7.4, P2 slice 6): a facility's paybill settings, the
 * paybill (C2B) confirmations Safaricom sends, matching each to a patient,
 * and the queue of those nothing matched. STK push is in `mpesa-stk.ts`;
 * the unauthenticated callbacks' entry points in `mpesa-callbacks.ts`.
 *
 * What a payer types as the account number means (decided 2026-11-06): an
 * invoice number settles that bill, an admission number is a deposit for
 * that stay, a patient number is credit on their account. Only an
 * unambiguous match is applied; anything else waits for a person, since a
 * payment on the wrong account is worse than one not yet placed.
 */

type TransactionRow = typeof mpesaTransactions.$inferSelect;

export class MpesaError extends Error {
  constructor(readonly code:
    | "not_set_up"
    | "not_found"
    | "not_unmatched"
    | "phone_invalid") {
    super({
      not_set_up: "M-Pesa is not set up for this facility",
      not_found: "No such M-Pesa transaction",
      not_unmatched: "This M-Pesa transaction is not waiting to be placed",
      phone_invalid: "A Kenyan mobile number is needed, e.g. 0712 345 678",
    }[code]);
    this.name = "MpesaError";
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** The URLs Safaricom calls for this facility. The token in them is a secret. */
export function callbackUrls(token: string) {
  const base = `${new URL(env.BETTER_AUTH_URL).origin}/webhooks/mpesa/${token}`;
  return { confirmation: `${base}/c2b/confirmation`, validation: `${base}/c2b/validation`, stk: `${base}/stk/callback` };
}

export function credentialsOf(stored: string): DarajaCredentials {
  return JSON.parse(decryptSecret(stored)) as DarajaCredentials;
}

/**
 * Saves the paybill and its credentials, encrypted, and queues the C2B URL
 * registration with Safaricom (rule 18: never from inside this transaction).
 * The callback token survives a change of credentials, so URLs already
 * registered keep working.
 */
export async function saveSettings(
  tx: AppDb,
  facilityId: string,
  input: { shortcode: string } & DarajaCredentials,
  actor: PatientActor,
) {
  const [existing] = await tx.select({ callbackToken: mpesaSettings.callbackToken }).from(mpesaSettings).limit(1);
  const credentials = encryptSecret(JSON.stringify({
    consumerKey: input.consumerKey,
    consumerSecret: input.consumerSecret,
    passkey: input.passkey,
  } satisfies DarajaCredentials));
  const values = { shortcode: input.shortcode, credentials, updatedBy: actor.membershipId, updatedAt: new Date(), urlsRegisteredAt: null };

  await tx.insert(mpesaSettings)
    .values({ facilityId, callbackToken: existing?.callbackToken ?? generateCallbackToken(), ...values })
    .onConflictDoUpdate({ target: mpesaSettings.facilityId, set: values });
  await enqueue(tx, { facilityId, operation: "mpesa.register_urls", subjectId: facilityId });
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "mpesa.settings_changed",
    entityType: "facility",
    entityId: facilityId,
    summary: `Set the M-Pesa paybill to ${input.shortcode}`,
    detail: { shortcode: input.shortcode },
  });
}

/** What the admin sees: never the credentials, only that they are set. */
export async function settingsView(tx: AppDb) {
  const [settings] = await tx.select().from(mpesaSettings).limit(1);
  if (!settings)
    return null;
  const [last] = await tx
    .select({ error: gatewayExchanges.error, at: gatewayExchanges.createdAt })
    .from(gatewayExchanges)
    .where(eq(gatewayExchanges.operation, "register_urls"))
    .orderBy(desc(gatewayExchanges.createdAt))
    .limit(1);
  return {
    shortcode: settings.shortcode,
    urlsRegisteredAt: settings.urlsRegisteredAt,
    lastRegistrationError: last?.error ?? null,
    callbackUrls: callbackUrls(settings.callbackToken),
  };
}

export async function recordExchange(
  tx: AppDb,
  facilityId: string,
  row: { operation: "register_urls" | "stk_push" | "stk_callback"; stkRequestId?: string | null; error?: string } & Partial<Exchange>,
) {
  await tx.insert(gatewayExchanges).values({
    facilityId,
    gateway: "daraja",
    operation: row.operation,
    stkRequestId: row.stkRequestId ?? null,
    request: row.request ?? null,
    response: row.response ?? null,
    httpStatus: row.httpStatus ?? null,
    error: row.error ?? null,
  });
}

/**
 * Outbox handler: registers the paybill's C2B URLs with Safaricom. Marks them
 * registered only if the settings are still the ones it registered (the
 * ciphertext changes on every save), so a change made meanwhile is
 * registered by its own job.
 */
export async function registerUrls(job: { facilityId: string; subjectId: string }): Promise<"done" | "skipped"> {
  const settings = await runAsFacility(job.facilityId, async tx => (await tx.select().from(mpesaSettings).limit(1))[0]);
  if (!settings)
    return "skipped";
  const urls = callbackUrls(settings.callbackToken);
  try {
    const exchange = await registerC2bUrls({
      shortcode: settings.shortcode,
      credentials: credentialsOf(settings.credentials),
      confirmationUrl: urls.confirmation,
      validationUrl: urls.validation,
    });
    await runAsFacility(job.facilityId, async (tx) => {
      await recordExchange(tx, job.facilityId, { operation: "register_urls", ...exchange });
      await tx.update(mpesaSettings).set({ urlsRegisteredAt: new Date() }).where(eq(mpesaSettings.credentials, settings.credentials));
    });
    return "done";
  }
  catch (err) {
    await runAsFacility(job.facilityId, tx =>
      recordExchange(tx, job.facilityId, { operation: "register_urls", ...exchangeOf(err), error: errorLine(err) }));
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Matching what the payer typed
// ---------------------------------------------------------------------------

/** Uppercased, separators and spaces removed: `inv-2026 000123` reads as `INV2026000123`. */
export function normaliseReference(value: string): string {
  return value.toUpperCase().replace(/[\s/\-_.]/g, "");
}

/** The same normalisation in SQL; the two must agree. */
function normalised(column: AnyColumn) {
  return sql`upper(regexp_replace(${column}, '[\\s/\\-_.]', '', 'g'))`;
}

export interface PaymentTarget {
  patientId: string;
  invoiceId?: string;
  encounterId?: string;
}

export type MatchOutcome
  = | { kind: "matched"; target: PaymentTarget }
    | { kind: "unmatched"; reason: "no_reference" | "no_candidate" | "ambiguous" };

const UNMATCHED_REASONS = {
  no_reference: "No account number was given",
  no_candidate: "No bill, admission or patient has this number",
  ambiguous: "More than one record has this number",
} as const;

function one<T>(rows: T[]): MatchOutcome | T | null {
  if (rows.length > 1)
    return { kind: "unmatched", reason: "ambiguous" };
  return rows[0] ?? null;
}

/**
 * Finds what a reference names, if exactly one thing: a patient's bill, an
 * admission, or a patient's OP or IP number, tried in that order. A payer's
 * bill is never matched: a patient's paybill payment is not the insurer's.
 */
export async function matchReference(tx: AppDb, reference: string | null): Promise<MatchOutcome> {
  const ref = reference ? normaliseReference(reference) : "";
  if (ref === "")
    return { kind: "unmatched", reason: "no_reference" };

  const bill = one(await tx
    .select({ invoiceId: invoices.id, patientId: accounts.patientId })
    .from(documents)
    .innerJoin(invoices, eq(invoices.documentId, documents.id))
    .innerJoin(accounts, eq(accounts.id, invoices.accountId))
    .where(and(eq(documents.kind, "invoice"), isNotNull(accounts.patientId), sql`${normalised(documents.number)} = ${ref}`)));
  if (bill && "kind" in bill)
    return bill;
  if (bill)
    return { kind: "matched", target: { patientId: bill.patientId!, invoiceId: bill.invoiceId } };

  const stay = one(await tx
    .select({ encounterId: admissions.encounterId, patientId: encounters.patientId })
    .from(admissions)
    .innerJoin(encounters, eq(encounters.id, admissions.encounterId))
    .where(sql`${normalised(admissions.admissionNumber)} = ${ref}`));
  if (stay && "kind" in stay)
    return stay;
  if (stay)
    return { kind: "matched", target: { patientId: stay.patientId, encounterId: stay.encounterId } };

  const patient = one(await tx
    .select({ patientId: patientNumbers.patientId })
    .from(patientNumbers)
    .where(sql`${normalised(patientNumbers.number)} = ${ref}`));
  if (patient && "kind" in patient)
    return patient;
  if (patient)
    return { kind: "matched", target: { patientId: patient.patientId } };

  return { kind: "unmatched", reason: "no_candidate" };
}

/**
 * Records a transaction's money as a payment towards `target` and marks it
 * allocated. If the target can no longer take it (a bill voided since, a
 * visit cancelled), the money is real all the same: it lands as credit on
 * the patient's account instead.
 */
export async function settleTransaction(
  tx: AppDb,
  facilityId: string,
  transaction: TransactionRow,
  target: PaymentTarget,
  actor: PatientActor | null,
): Promise<string> {
  const method: PaymentMethod = transaction.source === "stk" ? "mpesa_stk" : "mpesa_c2b";
  const input = {
    patientId: target.patientId,
    method,
    amountCents: transaction.amountCents,
    reference: transaction.transactionId,
    mpesaTransactionId: transaction.id,
    invoiceId: target.invoiceId,
    encounterId: target.encounterId,
  };
  let paymentId: string;
  try {
    // A savepoint, so a refused target leaves the transaction usable for the fallback.
    paymentId = await tx.transaction(sp => recordPayment(sp, facilityId, input, actor, transaction.transactedAt));
  }
  catch (err) {
    if (!(err instanceof PaymentError) || err.code === "patient_not_found" || (!target.invoiceId && !target.encounterId))
      throw err;
    paymentId = await recordPayment(tx, facilityId, { ...input, invoiceId: undefined, encounterId: undefined }, actor, transaction.transactedAt);
  }
  await tx.update(mpesaTransactions).set({ status: "allocated", statusReason: null }).where(eq(mpesaTransactions.id, transaction.id));
  return paymentId;
}

/** Tries to place one unmatched transaction by its reference; otherwise says why not. */
export async function matchTransaction(tx: AppDb, facilityId: string, id: string): Promise<MatchOutcome> {
  const [transaction] = await tx.select().from(mpesaTransactions).where(eq(mpesaTransactions.id, id)).for("update").limit(1);
  if (!transaction || transaction.status !== "unmatched")
    return { kind: "unmatched", reason: "no_candidate" };
  const outcome = await matchReference(tx, transaction.accountReference);
  if (outcome.kind === "matched")
    await settleTransaction(tx, facilityId, transaction, outcome.target, null);
  else
    await tx.update(mpesaTransactions).set({ statusReason: UNMATCHED_REASONS[outcome.reason] }).where(eq(mpesaTransactions.id, id));
  return outcome;
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

/** M-Pesa transactions, newest first; `unmatched` is the cashier's queue. At most 100. */
export async function listTransactions(tx: AppDb, filter: { status?: TransactionRow["status"]; id?: string } = {}) {
  return tx
    .select({
      id: mpesaTransactions.id,
      source: mpesaTransactions.source,
      transactionId: mpesaTransactions.transactionId,
      accountReference: mpesaTransactions.accountReference,
      msisdn: mpesaTransactions.msisdn,
      payerName: mpesaTransactions.payerName,
      amountCents: mpesaTransactions.amountCents,
      transactedAt: mpesaTransactions.transactedAt,
      status: mpesaTransactions.status,
      statusReason: mpesaTransactions.statusReason,
      paymentId: payments.id,
    })
    .from(mpesaTransactions)
    .leftJoin(payments, and(eq(payments.mpesaTransactionId, mpesaTransactions.id), isNull(payments.reversedAt)))
    .where(and(
      filter.status ? eq(mpesaTransactions.status, filter.status) : undefined,
      filter.id ? eq(mpesaTransactions.id, filter.id) : undefined,
    ))
    .orderBy(desc(mpesaTransactions.transactedAt), desc(mpesaTransactions.id))
    .limit(100);
}

export type ListedTransaction = Awaited<ReturnType<typeof listTransactions>>[number];

async function lockUnmatched(tx: AppDb, id: string): Promise<TransactionRow> {
  const [transaction] = await tx.select().from(mpesaTransactions).where(eq(mpesaTransactions.id, id)).for("update").limit(1);
  if (!transaction)
    throw new MpesaError("not_found");
  if (transaction.status !== "unmatched")
    throw new MpesaError("not_unmatched");
  return transaction;
}

/** A person places a transaction nothing matched: a patient, and optionally their bill or visit. */
export async function assignTransaction(tx: AppDb, facilityId: string, id: string, target: PaymentTarget, actor: PatientActor): Promise<string> {
  const transaction = await lockUnmatched(tx, id);
  const method: PaymentMethod = transaction.source === "stk" ? "mpesa_stk" : "mpesa_c2b";
  // No fallback here: the person chose the target, and a refusal is theirs to see.
  const paymentId = await recordPayment(tx, facilityId, {
    patientId: target.patientId,
    method,
    amountCents: transaction.amountCents,
    reference: transaction.transactionId,
    mpesaTransactionId: transaction.id,
    invoiceId: target.invoiceId,
    encounterId: target.encounterId,
  }, actor, transaction.transactedAt);
  await tx.update(mpesaTransactions).set({ status: "allocated", statusReason: null }).where(eq(mpesaTransactions.id, id));
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "mpesa.assigned",
    entityType: "mpesa_transaction",
    entityId: id,
    summary: `Placed M-Pesa ${transaction.transactionId} on a patient's account`,
    detail: { patientId: target.patientId, paymentId, invoiceId: target.invoiceId ?? null, encounterId: target.encounterId ?? null },
  });
  return paymentId;
}

/** Finance sets a transaction aside, e.g. paid in error and reversed with Safaricom. */
export async function rejectTransaction(tx: AppDb, facilityId: string, id: string, reason: string, actor: PatientActor) {
  const transaction = await lockUnmatched(tx, id);
  await tx.update(mpesaTransactions).set({ status: "rejected", statusReason: reason }).where(eq(mpesaTransactions.id, id));
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "mpesa.rejected",
    entityType: "mpesa_transaction",
    entityId: id,
    summary: `Set aside M-Pesa ${transaction.transactionId}: ${reason}`,
    detail: { reason },
  });
}
