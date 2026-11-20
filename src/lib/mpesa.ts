import type { AnyColumn } from "drizzle-orm";

import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { withAdvisoryLock } from "@/db";
import { accounts, admissions, documents, encounters, gatewayExchanges, invoices, mpesaSettings, mpesaTransactions, normalisedNumber, patientNumbers, payments } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import env from "@/env";

import type { DarajaCredentials, Exchange } from "./daraja";
import type { PatientActor } from "./patients";
import type { PaymentMethod } from "./payments";

import { recordAudit } from "./audit";
import { decryptSecret, encryptSecret, generateCallbackToken } from "./crypto";
import { exchangeOf, registerC2bUrls } from "./daraja";
import { isUniqueViolation, pgConstraintName } from "./db-errors";
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
    | "phone_invalid"
    | "paybill_taken"
    | "callback_not_found"
    | "already_replayed") {
    super({
      not_set_up: "M-Pesa is not set up for this facility",
      not_found: "No such M-Pesa transaction",
      not_unmatched: "This M-Pesa transaction is not waiting to be placed",
      phone_invalid: "A Kenyan mobile number is needed, e.g. 0712 345 678",
      paybill_taken: "This paybill is already set up for another facility. A paybill's payments can go to one facility only.",
      callback_not_found: "No such M-Pesa callback waiting to be replayed",
      already_replayed: "This M-Pesa callback has been replayed already",
    }[code]);
    this.name = "MpesaError";
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface CallbackUrls {
  confirmation: string;
  validation: string;
  stk: string;
}

/** The URLs Safaricom calls for this facility. The token in them is a secret. */
export function callbackUrls(token: string): CallbackUrls {
  const base = `${new URL(env.BETTER_AUTH_URL).origin}/webhooks/mpesa/${token}`;
  return { confirmation: `${base}/c2b/confirmation`, validation: `${base}/c2b/validation`, stk: `${base}/stk/callback` };
}

export function credentialsOf(stored: string): DarajaCredentials {
  return JSON.parse(decryptSecret(stored)) as DarajaCredentials;
}

/**
 * How long a replaced callback token keeps working once the new URLs are
 * registered: long enough for Safaricom's calls already on their way.
 */
export const PREVIOUS_TOKEN_GRACE_MS = 60 * 60 * 1000;

/**
 * How a prompt callback that came to a replaced token, and was not taken,
 * is kept (lib/mpesa-callbacks.ts): for a person to read, never applied to a
 * prompt or replayed by itself, since anyone holding the token could have
 * sent it.
 */
export const KEPT_ON_REPLACED_TOKEN = "Came to the replaced callback address, for no prompt sent before the replacement";

/**
 * Saves the paybill and its credentials, encrypted, and queues the C2B URL
 * registration with Safaricom (rule 18: never from inside this transaction).
 * The callback token survives a change of credentials, so URLs already
 * registered keep working. A paybill another facility has is refused: its
 * confirmations go to one set of URLs.
 */
export async function saveSettings(
  tx: AppDb,
  facilityId: string,
  input: { shortcode: string } & DarajaCredentials,
  actor: PatientActor,
): Promise<void> {
  const [existing] = await tx.select({ callbackToken: mpesaSettings.callbackToken }).from(mpesaSettings).limit(1);
  const credentials = encryptSecret(JSON.stringify({
    consumerKey: input.consumerKey,
    consumerSecret: input.consumerSecret,
    passkey: input.passkey,
  } satisfies DarajaCredentials));
  const values = { shortcode: input.shortcode, credentials, updatedBy: actor.membershipId, updatedAt: new Date(), urlsRegisteredAt: null };

  try {
    await tx.insert(mpesaSettings)
      .values({ facilityId, callbackToken: existing?.callbackToken ?? generateCallbackToken(), ...values })
      .onConflictDoUpdate({ target: mpesaSettings.facilityId, set: values });
  }
  catch (err) {
    if (isUniqueViolation(err) && pgConstraintName(err) === "mpesa_settings_shortcode_key")
      throw new MpesaError("paybill_taken");
    throw err;
  }
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

/**
 * Replaces the callback token, for one that may have leaked (ROADMAP.md P6).
 * Prompts sent from now carry the new one, and the new URLs are registered
 * with Safaricom in the background. In production Safaricom takes a
 * paybill's URLs once: the old registration is deleted on the Daraja portal
 * first, then registration is asked again (`requestRegistration`).
 *
 * The old token keeps working until the new URLs are registered, and an
 * hour after, but only so far as a leaked token can do no harm on its own
 * (lib/mpesa-callbacks.ts): a prompt sent before now has its outcome
 * recorded, and a paybill confirmation is kept but never placed by itself.
 * A second replacement meanwhile ends the oldest token at once.
 */
export async function rotateCallbackToken(tx: AppDb, facilityId: string, actor: PatientActor): Promise<void> {
  // Locked: a second replacement at once waits, then retires this one's token, and the oldest ends.
  const [settings] = await tx.select({ callbackToken: mpesaSettings.callbackToken }).from(mpesaSettings).limit(1).for("update");
  if (!settings)
    throw new MpesaError("not_set_up");
  // Taken once the lock is held: a prompt sent while this waited carried the old token, and counts as sent before.
  const rotatedAt = new Date();
  await tx.update(mpesaSettings).set({
    callbackToken: generateCallbackToken(),
    previousCallbackToken: settings.callbackToken,
    previousTokenUntil: null,
    callbackTokenRotatedAt: rotatedAt,
    urlsRegisteredAt: null,
  }).where(eq(mpesaSettings.facilityId, facilityId));
  await enqueue(tx, { facilityId, operation: "mpesa.register_urls", subjectId: facilityId });
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "mpesa.callback_token_rotated",
    entityType: "facility",
    entityId: facilityId,
    summary: "Replaced the M-Pesa callback token",
  });
}

/** Asks Safaricom again for the current URLs, once a registration it refused can go through. */
export async function requestRegistration(tx: AppDb, facilityId: string): Promise<void> {
  const [settings] = await tx.select({ facilityId: mpesaSettings.facilityId }).from(mpesaSettings).limit(1);
  if (!settings)
    throw new MpesaError("not_set_up");
  await enqueue(tx, { facilityId, operation: "mpesa.register_urls", subjectId: facilityId });
}

export interface MpesaSettingsView {
  shortcode: string;
  urlsRegisteredAt: Date | null;
  /** The last registration attempt's error, if it failed. */
  lastRegistrationError: string | null;
  callbackUrls: CallbackUrls;
  /** When the callback token was last replaced, if ever. */
  callbackTokenRotatedAt: Date | null;
  /** Whether the replaced token still works, and until when: null while the new URLs wait to be registered. */
  previousToken: { until: Date | null } | null;
}

/** What the admin sees: never the credentials, only that they are set. */
export async function settingsView(tx: AppDb): Promise<MpesaSettingsView | null> {
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
    callbackTokenRotatedAt: settings.callbackTokenRotatedAt,
    previousToken: settings.previousCallbackToken && (!settings.previousTokenUntil || settings.previousTokenUntil > new Date())
      ? { until: settings.previousTokenUntil }
      : null,
  };
}

export async function recordExchange(
  tx: AppDb,
  facilityId: string,
  row: { operation: typeof gatewayExchanges.$inferInsert["operation"]; stkRequestId?: string | null; error?: string } & Partial<Exchange>,
): Promise<void> {
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
 * ciphertext changes on every save, the token on every replacement). If they
 * changed while it ran, its registration may have landed after theirs, so it
 * asks again for the current ones: the last to land is then the current.
 * Once registered, a replaced token works for an hour more.
 */
export async function registerUrls(job: { facilityId: string; subjectId: string }): Promise<"done" | "skipped"> {
  const first = await runAsFacility(job.facilityId, async tx => (await tx.select().from(mpesaSettings).limit(1))[0]);
  if (!first)
    return "skipped";
  /*
   * One registration of a paybill at a time, whichever facility it is for,
   * from reading the settings to Safaricom's answer: a paybill can move to
   * another facility while this one's registration of it is with Safaricom,
   * and the later holder's must land last. One that finds the paybill's
   * under way is retried later.
   */
  const registered = await withAdvisoryLock(`mpesa-register:${first.shortcode}`, () => registerHeld(job, first.shortcode));
  if (!registered.held)
    throw new Error(`Another registration of paybill ${first.shortcode} is under way`);
  return registered.value;
}

/** The registration itself, under the paybill's lock. */
async function registerHeld(job: { facilityId: string; subjectId: string }, shortcode: string): Promise<"done" | "skipped"> {
  const settings = await runAsFacility(job.facilityId, async tx => (await tx.select().from(mpesaSettings).limit(1))[0]);
  // Moved to another paybill while this waited: the change queued its own registration.
  if (!settings || settings.shortcode !== shortcode)
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
      const now = new Date();
      const marked = await tx.update(mpesaSettings).set({
        urlsRegisteredAt: now,
        previousTokenUntil: sql`CASE WHEN ${mpesaSettings.previousCallbackToken} IS NOT NULL AND ${mpesaSettings.previousTokenUntil} IS NULL
          THEN ${new Date(now.getTime() + PREVIOUS_TOKEN_GRACE_MS)}::timestamptz ELSE ${mpesaSettings.previousTokenUntil} END`,
      }).where(and(eq(mpesaSettings.credentials, settings.credentials), eq(mpesaSettings.callbackToken, settings.callbackToken))).returning({ id: mpesaSettings.facilityId });
      if (marked.length === 0)
        await enqueue(tx, { facilityId: job.facilityId, operation: "mpesa.register_urls", subjectId: job.facilityId });
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

/** The same normalisation in SQL, shared with the indexes that serve it (schema.ts). */
function normalised(column: AnyColumn) {
  return normalisedNumber(column);
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

/**
 * Finds what a reference names, if exactly one thing: a patient's bill, an
 * admission, or a patient's OP or IP number. All three are looked up, so a
 * number naming more than one is ambiguous. A payer's bill is never
 * matched: a patient's paybill payment is not the insurer's.
 */
export async function matchReference(tx: AppDb, reference: string | null): Promise<MatchOutcome> {
  const ref = reference ? normaliseReference(reference) : "";
  if (ref === "")
    return { kind: "unmatched", reason: "no_reference" };

  const bills = await tx
    .select({ invoiceId: invoices.id, patientId: accounts.patientId })
    .from(documents)
    .innerJoin(invoices, eq(invoices.documentId, documents.id))
    .innerJoin(accounts, eq(accounts.id, invoices.accountId))
    .where(and(eq(documents.kind, "invoice"), isNotNull(accounts.patientId), sql`${normalised(documents.number)} = ${ref}`));
  const stays = await tx
    .select({ encounterId: admissions.encounterId, patientId: encounters.patientId })
    .from(admissions)
    .innerJoin(encounters, eq(encounters.id, admissions.encounterId))
    .where(sql`${normalised(admissions.admissionNumber)} = ${ref}`);
  const people = await tx
    .select({ patientId: patientNumbers.patientId })
    .from(patientNumbers)
    .where(sql`${normalised(patientNumbers.number)} = ${ref}`);

  // Every category is looked at: a number naming things in two of them (a bill
  // and someone's patient number, written alike) is a person's to decide.
  const targets: PaymentTarget[] = [
    ...bills.map(b => ({ patientId: b.patientId!, invoiceId: b.invoiceId })),
    ...stays.map(s => ({ patientId: s.patientId, encounterId: s.encounterId })),
    ...people.map(p => ({ patientId: p.patientId })),
  ];
  if (targets.length > 1)
    return { kind: "unmatched", reason: "ambiguous" };
  if (targets.length === 1)
    return { kind: "matched", target: targets[0] };
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

export interface ListedTransaction {
  id: string;
  source: TransactionRow["source"];
  transactionId: string;
  accountReference: string | null;
  msisdn: string;
  payerName: string | null;
  amountCents: number;
  transactedAt: Date;
  status: TransactionRow["status"];
  statusReason: string | null;
  /** The live payment it became, if placed. */
  paymentId: string | null;
}

/** M-Pesa transactions, newest first; `unmatched` is the cashier's queue. At most 100. */
export async function listTransactions(tx: AppDb, filter: { status?: TransactionRow["status"]; id?: string; transactionId?: string; offset?: number } = {}): Promise<ListedTransaction[]> {
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
      filter.transactionId ? eq(mpesaTransactions.transactionId, filter.transactionId.trim().toUpperCase()) : undefined,
    ))
    .orderBy(desc(mpesaTransactions.transactedAt), desc(mpesaTransactions.id))
    .limit(100)
    .offset(filter.offset ?? 0);
}

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
export async function rejectTransaction(tx: AppDb, facilityId: string, id: string, reason: string, actor: PatientActor): Promise<void> {
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
