import { and, eq, gt, isNull, lt, or } from "drizzle-orm";

import db from "@/db";
import { gatewayExchanges, mpesaSettings, mpesaStkRequests, mpesaTransactions } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";

import type { StkCallback } from "./daraja";
import type { StkCallbackRecord } from "./mpesa-stk";

import { recordAudit } from "./audit";
import { secretEquals } from "./crypto";
import { parseC2bConfirmation, parseStkCallback } from "./daraja";
import { isUniqueViolation } from "./db-errors";
import { errorLine } from "./error-summary";
import { logger } from "./logger";
import { KEPT_ON_REPLACED_TOKEN, matchTransaction, recordExchange } from "./mpesa";
import { NOT_RECORDED } from "./mpesa-replays";
import { recordStkCallback, settleStkCallback } from "./mpesa-stk";
import { normalizePhone } from "./phone";

/**
 * Safaricom's calls into us: no session and no facility. The token in the
 * callback path is the whole look-up, on the OWNER connection, and yields only
 * the facility whose URLs carry it; everything after runs as that tenant.
 * The shortcode in a payload is caller-supplied and decides nothing.
 *
 * Logs carry receipt numbers and amounts, never a payer's name, phone or
 * account reference (rule 10); the raw payload is in the database.
 *
 * A token replaced for one that may have leaked (lib/mpesa.ts) keeps working
 * for a while, but only so far as a leaked token can do no harm on its own:
 * a prompt sent before the replacement has its outcome recorded, and a
 * paybill confirmation is kept but never placed by itself, since anyone
 * holding the token could have sent it.
 */

interface CallbackSettings {
  facilityId: string;
  shortcode: string;
  /** Set when the call came on a replaced token: when it was replaced. */
  replacedAt: Date | null;
}

async function facilityForToken(token: string): Promise<CallbackSettings | null> {
  if (token.length !== 43)
    return null;
  const [settings] = await db
    .select({
      facilityId: mpesaSettings.facilityId,
      shortcode: mpesaSettings.shortcode,
      callbackToken: mpesaSettings.callbackToken,
      previousCallbackToken: mpesaSettings.previousCallbackToken,
      rotatedAt: mpesaSettings.callbackTokenRotatedAt,
    })
    .from(mpesaSettings)
    .where(or(
      eq(mpesaSettings.callbackToken, token),
      and(eq(mpesaSettings.previousCallbackToken, token), or(isNull(mpesaSettings.previousTokenUntil), gt(mpesaSettings.previousTokenUntil, new Date()))),
    ))
    .limit(1);
  if (!settings)
    return null;
  const base = { facilityId: settings.facilityId, shortcode: settings.shortcode };
  if (secretEquals(settings.callbackToken, token))
    return { ...base, replacedAt: null };
  if (settings.previousCallbackToken && settings.rotatedAt && secretEquals(settings.previousCallbackToken, token))
    return { ...base, replacedAt: settings.rotatedAt };
  return null;
}

/**
 * Whether the prompt with this checkout id was sent, with the old token in
 * its URL, before the token was replaced. Judged by its recorded send, not
 * by when it was asked for: a prompt asked for before but sent after carries
 * the new token. A send still being recorded as the token changed is not
 * counted, and its outcome is kept for a person instead.
 */
async function promptSentBefore(facilityId: string, checkoutRequestId: string | null, replacedAt: Date): Promise<boolean> {
  if (!checkoutRequestId)
    return false;
  const [prompt] = await runAsFacility(facilityId, tx => tx
    .select({ id: mpesaStkRequests.id })
    .from(mpesaStkRequests)
    .innerJoin(gatewayExchanges, and(eq(gatewayExchanges.stkRequestId, mpesaStkRequests.id), eq(gatewayExchanges.operation, "stk_push"), isNull(gatewayExchanges.error)))
    .where(and(eq(mpesaStkRequests.checkoutRequestId, checkoutRequestId), lt(gatewayExchanges.createdAt, replacedAt)))
    .limit(1));
  return Boolean(prompt);
}

/**
 * On a replaced token, whether to take a prompt callback. What is not taken
 * is kept for a person to read (`KEPT_ON_REPLACED_TOKEN`), never applied or
 * replayed by itself: it may be an outcome that came before its send was
 * recorded, or something sent by whoever holds the old token. So is one
 * whose prompt could not be looked up.
 */
async function takenOnReplacedToken(settings: CallbackSettings & { replacedAt: Date }, callback: StkCallback | null, payload: unknown): Promise<boolean> {
  let taken = false;
  try {
    taken = callback !== null && await promptSentBefore(settings.facilityId, callback.checkoutRequestId, settings.replacedAt);
  }
  catch (err) {
    logger.error({ error: errorLine(err), facilityId: settings.facilityId }, "Could not look up the prompt of an M-Pesa callback on a replaced callback token");
  }
  if (!taken) {
    await keepUnparsed(settings.facilityId, "stk_callback", payload, KEPT_ON_REPLACED_TOKEN);
    logger.error({ facilityId: settings.facilityId }, "M-Pesa prompt callback on a replaced callback token, for no prompt sent before it; kept for a person");
  }
  return taken;
}

/** A callback we could not read or record, kept exactly as sent (rule 18), for a person to recover by hand. */
async function keepUnparsed(facilityId: string, operation: "c2b_confirmation" | "stk_callback", payload: unknown, error = "Could not be read") {
  await runAsFacility(facilityId, tx =>
    recordExchange(tx, facilityId, { operation, response: payload as Record<string, unknown>, error }));
}

/** Daraja treats anything else as a failure and retries. */
export const ACCEPTED = { ResultCode: 0, ResultDesc: "Accepted" } as const;

export type CallbackAnswer = { status: 200; body: typeof ACCEPTED } | { status: 404; body: { ResultCode: 1; ResultDesc: string } };

const UNKNOWN: CallbackAnswer = { status: 404, body: { ResultCode: 1, ResultDesc: "Unknown callback token" } };

/**
 * A paybill confirmation: stored exactly as sent, then matched in a second
 * transaction, so a failure to match never loses the record of money that
 * arrived. A retry finds the receipt number on file and is acknowledged. An
 * unknown token is the one non-success, so a stale registration shows up in
 * Safaricom's retries instead of vanishing.
 */
export async function onC2bConfirmation(token: string, payload: unknown): Promise<CallbackAnswer> {
  const settings = await facilityForToken(token);
  if (!settings) {
    logger.error({ tokenPrefix: token.slice(0, 6) }, "M-Pesa confirmation for an unknown callback token");
    return UNKNOWN;
  }
  const parsed = parseC2bConfirmation(payload);
  if (!parsed) {
    // Retrying cannot make it parse, so it is kept as sent for someone to read.
    await keepUnparsed(settings.facilityId, "c2b_confirmation", payload);
    logger.error({ facilityId: settings.facilityId }, "Unparseable M-Pesa confirmation");
    return { status: 200, body: ACCEPTED };
  }

  // Another paybill, e.g. the old one while a change settles, or a replaced token: never matched by itself, but a person may place it.
  const foreign = parsed.shortcode !== settings.shortcode;
  const replaced = settings.replacedAt !== null;
  let id: string;
  try {
    id = await runAsFacility(settings.facilityId, async (tx) => {
      const [row] = await tx.insert(mpesaTransactions).values({
        facilityId: settings.facilityId,
        source: "c2b",
        transactionId: parsed.transactionId,
        shortcode: parsed.shortcode,
        accountReference: parsed.accountReference,
        msisdn: normalizePhone(parsed.msisdn) ?? parsed.msisdn,
        payerName: parsed.payerName,
        amountCents: parsed.amountCents,
        transactedAt: parsed.transactedAt,
        rawPayload: payload as Record<string, unknown>,
        statusReason: foreign
          ? `Paid to paybill ${parsed.shortcode}, not this facility's current one; check before placing it`
          : replaced ? "Came to the replaced M-Pesa callback address; check it against the M-Pesa statement before placing it" : null,
      }).returning({ id: mpesaTransactions.id });
      await recordAudit(tx, {
        facilityId: settings.facilityId,
        actorId: null,
        action: "mpesa.received",
        entityType: "mpesa_transaction",
        entityId: row.id,
        summary: `M-Pesa ${parsed.transactionId} received`,
        detail: { amountCents: parsed.amountCents, source: "c2b" },
      });
      return row.id;
    });
  }
  catch (err) {
    if (isUniqueViolation(err))
      return { status: 200, body: ACCEPTED };
    logger.error({ error: errorLine(err), facilityId: settings.facilityId, transactionId: parsed.transactionId }, "Failed to store an M-Pesa confirmation");
    throw err;
  }
  if (foreign) {
    logger.error({ facilityId: settings.facilityId, transactionId: parsed.transactionId }, "M-Pesa confirmation for another paybill");
    return { status: 200, body: ACCEPTED };
  }
  if (replaced) {
    logger.error({ facilityId: settings.facilityId, transactionId: parsed.transactionId }, "M-Pesa confirmation on a replaced callback token; kept for a person to check");
    return { status: 200, body: ACCEPTED };
  }

  try {
    await runAsFacility(settings.facilityId, tx => matchTransaction(tx, settings.facilityId, id));
  }
  catch (err) {
    // Stored and unmatched: it waits in the queue for a person.
    logger.error({ error: errorLine(err), facilityId: settings.facilityId, transactionId: parsed.transactionId }, "Failed to match an M-Pesa confirmation");
  }
  return { status: 200, body: ACCEPTED };
}

/**
 * Validation runs before the payer's money moves, and refusing would fail
 * their payment at the till. A reference we do not know is the normal case,
 * so every payment is accepted, even for an unknown token.
 */
export async function onC2bValidation(token: string): Promise<CallbackAnswer> {
  // Answered without waiting: a failed lookup must not become a declined payment.
  facilityForToken(token)
    .then((settings) => {
      if (!settings)
        logger.warn({ tokenPrefix: token.slice(0, 6) }, "M-Pesa validation for an unknown callback token; accepted");
      else if (settings.replacedAt)
        logger.warn({ facilityId: settings.facilityId }, "M-Pesa validation on a replaced callback token; accepted");
    })
    .catch((err: unknown) => logger.warn({ error: errorLine(err) }, "M-Pesa validation lookup failed; accepted"));
  return { status: 200, body: ACCEPTED };
}

/** An STK push's outcome. */
export async function onStkCallback(token: string, payload: unknown): Promise<CallbackAnswer> {
  const settings = await facilityForToken(token);
  if (!settings) {
    logger.error({ tokenPrefix: token.slice(0, 6) }, "M-Pesa prompt callback for an unknown callback token");
    return UNKNOWN;
  }
  const parsed = parseStkCallback(payload);
  // On a replaced token, only the outcome of a prompt sent before the replacement is taken.
  if (settings.replacedAt && !await takenOnReplacedToken({ ...settings, replacedAt: settings.replacedAt }, parsed, payload))
    return UNKNOWN;
  if (!parsed) {
    await keepUnparsed(settings.facilityId, "stk_callback", payload);
    logger.error({ facilityId: settings.facilityId }, "Unparseable M-Pesa prompt callback");
    return { status: 200, body: ACCEPTED };
  }
  // Kept first, in its own transaction, as a paybill confirmation is: placing it can then fail without losing it.
  let recorded: StkCallbackRecord;
  try {
    recorded = await runAsFacility(settings.facilityId, tx => recordStkCallback(tx, settings.facilityId, settings.shortcode, parsed, payload));
  }
  catch (err) {
    // Safaricom does not call back again, so what it said is kept by itself for a
    // person to place. If even that fails, the error stands and nothing is acknowledged.
    await keepUnparsed(settings.facilityId, "stk_callback", payload, NOT_RECORDED);
    logger.error({ error: errorLine(err), facilityId: settings.facilityId, transactionId: parsed.receiptNumber }, "Failed to record an M-Pesa prompt callback; kept for a person to place");
    return { status: 200, body: ACCEPTED };
  }
  if (recorded.outcome === "unusable")
    logger.error({ facilityId: settings.facilityId }, "M-Pesa prompt callback reported success without a receipt or amount");
  if (recorded.outcome === "settle") {
    try {
      await runAsFacility(settings.facilityId, tx => settleStkCallback(tx, settings.facilityId, recorded.requestId, recorded.transactionId));
    }
    catch (err) {
      logger.error({ error: errorLine(err), facilityId: settings.facilityId, transactionId: parsed.receiptNumber }, "Failed to place an M-Pesa prompt's payment; it waits in the queue");
    }
  }
  return { status: 200, body: ACCEPTED };
}
