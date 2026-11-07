import { and, desc, eq, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { accounts, admissions, documents, encounters, gatewayExchanges, invoices, memberships, mpesaSettings, mpesaStkRequests, mpesaTransactions, patientNumbers, patients, payments, stkCheckoutId } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";

import type { StkCallback } from "./daraja";
import type { PaymentTarget } from "./mpesa";
import type { PatientActor } from "./patients";

import { recordAudit } from "./audit";
import { exchangeOf, parseStkCallback, stkPush } from "./daraja";
import { isUniqueViolation } from "./db-errors";
import { errorLine } from "./error-summary";
import { formatKes } from "./money";
import { callbackUrls, credentialsOf, MpesaError, recordExchange, settleTransaction } from "./mpesa";
import { enqueue } from "./outbox";
import { PaymentError } from "./payments";
import { normalizePhone } from "./phone";

/**
 * STK push (P2 slice 6): the cashier asks Safaricom to prompt a patient's
 * phone to pay the paybill. The prompt goes out through the outbox (rule 18)
 * and is never sent twice: Daraja has no idempotency key, so a repeat could
 * charge twice. A request is marked `sending`, in its own committed
 * transaction, before Safaricom is called; a job that finds one `sending`
 * (a worker that died mid-call) closes it as failed instead of sending
 * again. Money from a prompt we cannot place still lands in the M-Pesa queue.
 */

type StkRow = typeof mpesaStkRequests.$inferSelect;
type TransactionRow = typeof mpesaTransactions.$inferSelect;

/** Checks the target now, so the cashier hears at once; the callback checks again. */
async function checkTarget(tx: AppDb, target: PaymentTarget) {
  const [patient] = await tx.select({ id: patients.id }).from(patients).where(eq(patients.id, target.patientId)).limit(1);
  if (!patient)
    throw new PaymentError("patient_not_found");
  if (target.invoiceId) {
    const [bill] = await tx
      .select({ status: invoices.status, patientId: accounts.patientId })
      .from(invoices)
      .innerJoin(accounts, eq(accounts.id, invoices.accountId))
      .where(eq(invoices.id, target.invoiceId))
      .limit(1);
    if (!bill)
      throw new PaymentError("invoice_not_found");
    if (bill.patientId !== target.patientId)
      throw new PaymentError("other_patient");
    if (bill.status !== "finalised")
      throw new PaymentError("not_finalised");
  }
  if (target.encounterId) {
    const [encounter] = await tx.select().from(encounters).where(eq(encounters.id, target.encounterId)).limit(1);
    if (!encounter)
      throw new PaymentError("encounter_not_found");
    if (encounter.patientId !== target.patientId)
      throw new PaymentError("other_patient");
    if (encounter.status === "cancelled")
      throw new PaymentError("encounter_cancelled");
  }
}

/** Queues a prompt to `phone` for `amountCents`, towards `target`. */
export async function requestStkPush(
  tx: AppDb,
  facilityId: string,
  input: PaymentTarget & { phone: string; amountCents: number },
  actor: PatientActor,
): Promise<string> {
  const [settings] = await tx.select({ shortcode: mpesaSettings.shortcode }).from(mpesaSettings).limit(1);
  if (!settings)
    throw new MpesaError("not_set_up");
  const phone = normalizePhone(input.phone);
  if (!phone?.startsWith("+2547") && !phone?.startsWith("+2541"))
    throw new MpesaError("phone_invalid");
  await checkTarget(tx, input);

  const [request] = await tx.insert(mpesaStkRequests).values({
    facilityId,
    patientId: input.patientId,
    invoiceId: input.invoiceId ?? null,
    encounterId: input.encounterId ?? null,
    phone,
    amountCents: input.amountCents,
    requestedBy: actor.membershipId,
  }).returning({ id: mpesaStkRequests.id });
  await enqueue(tx, { facilityId, operation: "mpesa.stk_push", subjectId: request.id });
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "mpesa.stk_requested",
    entityType: "mpesa_stk_request",
    entityId: request.id,
    summary: `Asked for ${formatKes(input.amountCents)} by M-Pesa prompt`,
    detail: { patientId: input.patientId, amountCents: input.amountCents, invoiceId: input.invoiceId ?? null, encounterId: input.encounterId ?? null },
  });
  return request.id;
}

/** What the payer's statement shows: the bill, admission or patient number. */
async function accountReference(tx: AppDb, request: StkRow): Promise<string> {
  if (request.invoiceId) {
    const [bill] = await tx.select({ number: documents.number }).from(invoices).innerJoin(documents, eq(documents.id, invoices.documentId)).where(eq(invoices.id, request.invoiceId)).limit(1);
    if (bill)
      return bill.number;
  }
  if (request.encounterId) {
    const [stay] = await tx.select({ number: admissions.admissionNumber }).from(admissions).where(eq(admissions.encounterId, request.encounterId)).limit(1);
    if (stay)
      return stay.number;
  }
  const [op] = await tx.select({ number: patientNumbers.number }).from(patientNumbers).where(eq(patientNumbers.patientId, request.patientId)).limit(1);
  return op?.number ?? "Hospital";
}

async function closeFailed(tx: AppDb, requestId: string, resultDesc: string, resultCode: number | null = null) {
  await tx.update(mpesaStkRequests)
    .set({ status: "failed", resultCode, resultDesc: resultDesc.slice(0, 200), completedAt: new Date() })
    .where(eq(mpesaStkRequests.id, requestId));
}

/**
 * Claims a queued request for sending, in its own transaction, so a retry of
 * the job can tell it was already being sent. One found `sending` is closed:
 * whether Safaricom got it is unknown, and asking again could charge twice.
 */
async function claimForSending(facilityId: string, requestId: string) {
  return runAsFacility(facilityId, async (tx) => {
    const [request] = await tx.select().from(mpesaStkRequests).where(eq(mpesaStkRequests.id, requestId)).for("update").limit(1);
    if (request?.status === "sending") {
      await closeFailed(tx, request.id, "Sending was interrupted; if the patient paid, the payment is in the M-Pesa queue");
      return null;
    }
    const [settings] = await tx.select().from(mpesaSettings).limit(1);
    if (!request || request.status !== "queued")
      return null;
    if (!settings) {
      await closeFailed(tx, request.id, "M-Pesa is not set up");
      return null;
    }
    await tx.update(mpesaStkRequests).set({ status: "sending" }).where(eq(mpesaStkRequests.id, request.id));
    return { request, settings, reference: await accountReference(tx, request) };
  });
}

/** Outbox handler: sends a queued prompt once, and records what Safaricom said. */
export async function sendStkPush(job: { facilityId: string; subjectId: string }): Promise<"done" | "skipped"> {
  const claimed = await claimForSending(job.facilityId, job.subjectId);
  if (!claimed)
    return "skipped";
  const { request, settings, reference } = claimed;

  let sent: Awaited<ReturnType<typeof stkPush>>;
  try {
    sent = await stkPush({
      shortcode: settings.shortcode,
      credentials: credentialsOf(settings.credentials),
      callbackUrl: callbackUrls(settings.callbackToken).stk,
      phone: request.phone,
      amountCents: request.amountCents,
      accountReference: reference,
      description: "Hospital bill",
    });
  }
  catch (err) {
    await runAsFacility(job.facilityId, async (tx) => {
      await recordExchange(tx, job.facilityId, { operation: "stk_push", stkRequestId: request.id, ...exchangeOf(err), error: errorLine(err) });
      await closeFailed(tx, request.id, err instanceof Error ? err.message : "The prompt could not be sent");
    });
    return "done";
  }

  // If this write fails the job is retried, finds the request `sending`, and closes it: never a second prompt.
  await runAsFacility(job.facilityId, tx => recordSent(tx, job.facilityId, request.id, sent));
  return "done";
}

/**
 * Serialises the two writers of one checkout: the send recording Safaricom's
 * answer, and a callback for it. Whichever comes second waits, then sees the
 * first one's rows, so an early callback is never missed by both. Released
 * when the transaction ends.
 */
export async function lockCheckout(tx: AppDb, facilityId: string, checkoutRequestId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`stk:${facilityId}:${checkoutRequestId}`}, 0))`);
}

/** Records that Safaricom has the prompt, and applies a callback that beat this here. */
export async function recordSent(tx: AppDb, facilityId: string, requestId: string, sent: Awaited<ReturnType<typeof stkPush>>) {
  await lockCheckout(tx, facilityId, sent.checkoutRequestId);
  await recordExchange(tx, facilityId, { operation: "stk_push", stkRequestId: requestId, ...sent });
  await tx.update(mpesaStkRequests).set({ status: "sent", checkoutRequestId: sent.checkoutRequestId }).where(eq(mpesaStkRequests.id, requestId));
  await applyEarlyCallback(tx, facilityId, requestId, sent.checkoutRequestId);
}

const checkoutOf = stkCheckoutId;

/**
 * Safaricom can call back before we have recorded the checkout id. Such a
 * callback was kept with no prompt: a payment in the queue, or a refusal in
 * the exchanges. Once the checkout id is known, it is applied to its prompt.
 */
async function applyEarlyCallback(tx: AppDb, facilityId: string, requestId: string, checkoutRequestId: string) {
  const [early] = await tx
    .select()
    .from(mpesaTransactions)
    .where(and(eq(mpesaTransactions.source, "stk"), eq(mpesaTransactions.status, "unmatched"), sql`${checkoutOf(mpesaTransactions.rawPayload)} = ${checkoutRequestId}`))
    .for("update")
    .limit(1);
  const [request] = await tx.select().from(mpesaStkRequests).where(eq(mpesaStkRequests.id, requestId)).limit(1);
  if (early) {
    await settleForRequest(tx, facilityId, request, early);
    return;
  }
  const [refused] = await tx
    .select({ response: gatewayExchanges.response })
    .from(gatewayExchanges)
    .where(and(eq(gatewayExchanges.operation, "stk_callback"), sql`${checkoutOf(gatewayExchanges.response)} = ${checkoutRequestId}`))
    .orderBy(desc(gatewayExchanges.createdAt))
    .limit(1);
  const callback = refused ? parseStkCallback(refused.response) : null;
  if (callback && callback.resultCode !== 0)
    await closeFailed(tx, request.id, callback.resultDesc, callback.resultCode);
}

async function actorOf(tx: AppDb, membershipId: string): Promise<PatientActor> {
  const [membership] = await tx.select({ userId: memberships.userId }).from(memberships).where(eq(memberships.id, membershipId)).limit(1);
  return { userId: membership.userId, membershipId };
}

/**
 * Places a prompt's money towards what the prompt was for, received by the
 * cashier who asked. A different amount from the one prompted is left in
 * the queue for a person: the patient may have paid something else.
 */
async function settleForRequest(tx: AppDb, facilityId: string, request: StkRow, transaction: TransactionRow): Promise<"paid" | "queued"> {
  if (request.status === "completed")
    return "queued";
  if (transaction.amountCents !== request.amountCents) {
    await tx.update(mpesaTransactions)
      .set({ statusReason: `Paid ${formatKes(transaction.amountCents)} against a prompt for ${formatKes(request.amountCents)}; check before placing it` })
      .where(eq(mpesaTransactions.id, transaction.id));
    await closeFailed(tx, request.id, "Paid a different amount; the payment is in the M-Pesa queue");
    return "queued";
  }
  const target = { patientId: request.patientId, invoiceId: request.invoiceId ?? undefined, encounterId: request.encounterId ?? undefined };
  await settleTransaction(tx, facilityId, transaction, target, await actorOf(tx, request.requestedBy));
  await tx.update(mpesaStkRequests)
    .set({ status: "completed", resultCode: 0, mpesaTransactionId: transaction.id, completedAt: new Date() })
    .where(eq(mpesaStkRequests.id, request.id));
  return "paid";
}

export type StkCallbackRecord
  = | { outcome: "failed" | "unusable" | "queued" }
    | { outcome: "settle"; requestId: string; transactionId: string };

/**
 * Safaricom's answer to a prompt, kept in its own transaction: the exchange,
 * and money received as an M-Pesa transaction. A failure closes the prompt.
 * Placing the money is a second step (`settleStkCallback`), so if that fails
 * the payment still waits in the queue. A receipt already on file is
 * Safaricom repeating itself, or the paybill confirmation of the same
 * payment arriving first; the latter, still unplaced, is placed against the
 * prompt.
 */
export async function recordStkCallback(
  tx: AppDb,
  facilityId: string,
  shortcode: string,
  callback: StkCallback,
  payload: unknown,
): Promise<StkCallbackRecord> {
  // Waits for a send recording this checkout id to commit, so the request lookup sees it.
  if (callback.checkoutRequestId)
    await lockCheckout(tx, facilityId, callback.checkoutRequestId);
  const [request] = callback.checkoutRequestId
    ? await tx.select().from(mpesaStkRequests).where(eq(mpesaStkRequests.checkoutRequestId, callback.checkoutRequestId)).for("update").limit(1)
    : [];
  await recordExchange(tx, facilityId, { operation: "stk_callback", stkRequestId: request?.id ?? null, response: payload as Record<string, unknown> });

  if (callback.resultCode !== 0) {
    if (request?.status === "sent")
      await closeFailed(tx, request.id, callback.resultDesc, callback.resultCode);
    return { outcome: "failed" };
  }
  // No amount or receipt: nothing can be booked. The callback is kept above, and the caller logs it.
  if (!callback.receiptNumber || !callback.amountCents || callback.amountCents % 100 !== 0)
    return { outcome: "unusable" };

  let transaction: TransactionRow;
  try {
    [transaction] = await tx.transaction(sp => sp.insert(mpesaTransactions).values({
      facilityId,
      source: "stk",
      transactionId: callback.receiptNumber!,
      shortcode,
      msisdn: (callback.phone && normalizePhone(callback.phone)) ?? callback.phone ?? request?.phone ?? "unknown",
      amountCents: callback.amountCents!,
      transactedAt: callback.transactedAt ?? new Date(),
      rawPayload: payload as Record<string, unknown>,
      statusReason: request ? "Paid for an M-Pesa prompt; not yet placed" : "No prompt on record for this payment",
    }).returning());
  }
  catch (err) {
    if (!isUniqueViolation(err))
      throw err;
    [transaction] = await tx.select().from(mpesaTransactions).where(eq(mpesaTransactions.transactionId, callback.receiptNumber)).for("update").limit(1);
    // The paybill confirmation came first and its reference placed it already
    // (an admission or patient number): one payment, now the prompt's too.
    if (transaction?.status === "allocated" && request && request.status !== "completed" && transaction.amountCents === request.amountCents) {
      await tx.update(mpesaStkRequests)
        .set({ status: "completed", resultCode: 0, mpesaTransactionId: transaction.id, completedAt: new Date() })
        .where(eq(mpesaStkRequests.id, request.id));
      return { outcome: "queued" };
    }
    if (!transaction || transaction.status !== "unmatched")
      return { outcome: "queued" };
  }

  // A prompt we closed as failed (interrupted, or a timeout) can still have been paid: place it all the same.
  if (!request || request.status === "completed")
    return { outcome: "queued" };
  return { outcome: "settle", requestId: request.id, transactionId: transaction.id };
}

/** The second step: places a kept STK payment towards its prompt. Safe to repeat. */
export async function settleStkCallback(tx: AppDb, facilityId: string, requestId: string, transactionId: string): Promise<"paid" | "queued"> {
  const [request] = await tx.select().from(mpesaStkRequests).where(eq(mpesaStkRequests.id, requestId)).for("update").limit(1);
  const [transaction] = await tx.select().from(mpesaTransactions).where(eq(mpesaTransactions.id, transactionId)).for("update").limit(1);
  if (!request || !transaction || transaction.status !== "unmatched")
    return "queued";
  return settleForRequest(tx, facilityId, request, transaction);
}

/** A prompt as the cashier polls it, with the payment it became and whether that was reversed. */
export async function stkRequestView(tx: AppDb, id: string) {
  const [request] = await tx.select().from(mpesaStkRequests).where(eq(mpesaStkRequests.id, id)).limit(1);
  if (!request)
    return null;
  const [paid] = request.mpesaTransactionId
    ? await tx
        .select({ receiptNumber: mpesaTransactions.transactionId, paymentId: payments.id, reversedAt: payments.reversedAt })
        .from(mpesaTransactions)
        .leftJoin(payments, eq(payments.mpesaTransactionId, mpesaTransactions.id))
        .where(eq(mpesaTransactions.id, request.mpesaTransactionId))
        // The live payment if there is one (it may have been reversed and placed again), else the reversed one.
        .orderBy(sql`${payments.reversedAt} IS NULL DESC`, desc(payments.receivedAt))
        .limit(1)
    : [];
  return {
    ...request,
    receiptNumber: paid?.receiptNumber ?? null,
    paymentId: paid?.paymentId ?? null,
    paymentReversed: paid?.reversedAt != null,
  };
}
