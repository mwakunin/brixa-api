import { eq } from "drizzle-orm";

import type { AppDb } from "@/db";

import { accounts, admissions, documents, encounters, invoices, memberships, mpesaSettings, mpesaStkRequests, mpesaTransactions, patientNumbers, patients } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";

import type { StkCallback } from "./daraja";
import type { PaymentTarget } from "./mpesa";
import type { PatientActor } from "./patients";

import { recordAudit } from "./audit";
import { exchangeOf, stkPush } from "./daraja";
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
 * and is never repeated automatically: Daraja has no idempotency key, so a
 * retry after a timeout could prompt, and charge, twice. Safaricom's callback
 * then records the payment towards what the prompt was for. Money that
 * arrives for a prompt we cannot place still lands in the M-Pesa queue.
 */

type StkRow = typeof mpesaStkRequests.$inferSelect;

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

/** Outbox handler: sends a queued prompt once, and records what Safaricom said. */
export async function sendStkPush(job: { facilityId: string; subjectId: string }): Promise<"done" | "skipped"> {
  const loaded = await runAsFacility(job.facilityId, async (tx) => {
    const [request] = await tx.select().from(mpesaStkRequests).where(eq(mpesaStkRequests.id, job.subjectId)).limit(1);
    const [settings] = await tx.select().from(mpesaSettings).limit(1);
    if (!request || request.status !== "queued" || !settings)
      return null;
    return { request, settings, reference: await accountReference(tx, request) };
  });
  if (!loaded)
    return "skipped";
  const { request, settings, reference } = loaded;

  try {
    const sent = await stkPush({
      shortcode: settings.shortcode,
      credentials: credentialsOf(settings.credentials),
      callbackUrl: callbackUrls(settings.callbackToken).stk,
      phone: request.phone,
      amountCents: request.amountCents,
      accountReference: reference,
      description: "Hospital bill",
    });
    await runAsFacility(job.facilityId, async (tx) => {
      await recordExchange(tx, job.facilityId, { operation: "stk_push", stkRequestId: request.id, ...sent });
      await tx.update(mpesaStkRequests).set({ status: "sent", checkoutRequestId: sent.checkoutRequestId }).where(eq(mpesaStkRequests.id, request.id));
    });
  }
  catch (err) {
    // Never retried (see above): the cashier sees it failed and can prompt again.
    await runAsFacility(job.facilityId, async (tx) => {
      await recordExchange(tx, job.facilityId, { operation: "stk_push", stkRequestId: request.id, ...exchangeOf(err), error: errorLine(err) });
      await tx.update(mpesaStkRequests)
        .set({ status: "failed", resultDesc: err instanceof Error ? err.message.slice(0, 200) : "The prompt could not be sent", completedAt: new Date() })
        .where(eq(mpesaStkRequests.id, request.id));
    });
  }
  return "done";
}

async function actorOf(tx: AppDb, membershipId: string): Promise<PatientActor> {
  const [membership] = await tx.select({ userId: memberships.userId }).from(memberships).where(eq(memberships.id, membershipId)).limit(1);
  return { userId: membership.userId, membershipId };
}

/**
 * Safaricom's answer to a prompt, inside the facility's transaction. A
 * failure closes the request. Money received becomes an M-Pesa transaction
 * and, when the prompt is ours, a payment towards what it was for, received
 * by the cashier who asked. A retried callback finds the transaction already
 * recorded and changes nothing.
 */
export async function completeStkPush(
  tx: AppDb,
  facilityId: string,
  shortcode: string,
  callback: StkCallback,
  payload: unknown,
): Promise<"failed" | "paid" | "queued" | "duplicate" | "unusable"> {
  const [request] = await tx.select().from(mpesaStkRequests).where(eq(mpesaStkRequests.checkoutRequestId, callback.checkoutRequestId)).for("update").limit(1);
  await recordExchange(tx, facilityId, { operation: "stk_callback", stkRequestId: request?.id ?? null, response: payload as Record<string, unknown> });

  if (callback.resultCode !== 0) {
    if (request && request.status === "sent") {
      await tx.update(mpesaStkRequests)
        .set({ status: "failed", resultCode: callback.resultCode, resultDesc: callback.resultDesc.slice(0, 200), completedAt: new Date() })
        .where(eq(mpesaStkRequests.id, request.id));
    }
    return "failed";
  }
  if (!callback.receiptNumber || !callback.amountCents || callback.amountCents % 100 !== 0)
    return "unusable";

  let transaction: typeof mpesaTransactions.$inferSelect;
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
      statusReason: request ? null : "No prompt on record for this payment",
    }).returning());
  }
  catch (err) {
    if (isUniqueViolation(err))
      return "duplicate";
    throw err;
  }

  // A prompt we marked failed (a timeout) can still have been paid: place it all the same.
  if (!request || request.status === "completed")
    return "queued";
  const target = { patientId: request.patientId, invoiceId: request.invoiceId ?? undefined, encounterId: request.encounterId ?? undefined };
  await settleTransaction(tx, facilityId, transaction, target, await actorOf(tx, request.requestedBy));
  await tx.update(mpesaStkRequests)
    .set({ status: "completed", resultCode: 0, resultDesc: callback.resultDesc.slice(0, 200), mpesaTransactionId: transaction.id, completedAt: new Date() })
    .where(eq(mpesaStkRequests.id, request.id));
  return "paid";
}

/** A prompt as the cashier polls it, with the payment it became. */
export async function stkRequestView(tx: AppDb, id: string) {
  const [request] = await tx.select().from(mpesaStkRequests).where(eq(mpesaStkRequests.id, id)).limit(1);
  if (!request)
    return null;
  const [transaction] = request.mpesaTransactionId
    ? await tx.select({ transactionId: mpesaTransactions.transactionId }).from(mpesaTransactions).where(eq(mpesaTransactions.id, request.mpesaTransactionId)).limit(1)
    : [];
  return { ...request, receiptNumber: transaction?.transactionId ?? null };
}
