import { eq } from "drizzle-orm";

import db from "@/db";
import { mpesaSettings, mpesaTransactions } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";

import { recordAudit } from "./audit";
import { secretEquals } from "./crypto";
import { parseC2bConfirmation, parseStkCallback } from "./daraja";
import { isUniqueViolation } from "./db-errors";
import { logger } from "./logger";
import { matchTransaction } from "./mpesa";
import { completeStkPush } from "./mpesa-stk";
import { normalizePhone } from "./phone";

/**
 * Safaricom's calls into us: no session and no facility. The token in the
 * callback path is the whole look-up, on the OWNER connection, and yields only
 * the facility whose URLs carry it; everything after runs as that tenant.
 * The shortcode in a payload is caller-supplied and decides nothing.
 *
 * Logs carry receipt numbers and amounts, never a payer's name, phone or
 * account reference (rule 10); the raw payload is in the database.
 */

async function facilityForToken(token: string) {
  if (token.length !== 43)
    return null;
  const [settings] = await db
    .select({ facilityId: mpesaSettings.facilityId, shortcode: mpesaSettings.shortcode, callbackToken: mpesaSettings.callbackToken })
    .from(mpesaSettings)
    .where(eq(mpesaSettings.callbackToken, token))
    .limit(1);
  return settings && secretEquals(settings.callbackToken, token) ? settings : null;
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
    // Retrying cannot make it parse; Safaricom's statement still has it.
    logger.error({ facilityId: settings.facilityId }, "Unparseable M-Pesa confirmation");
    return { status: 200, body: ACCEPTED };
  }

  // Another paybill's money posted to our token is evidence, kept but never placed.
  const foreign = parsed.shortcode !== settings.shortcode;
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
        status: foreign ? "rejected" : "unmatched",
        statusReason: foreign ? `Paybill ${parsed.shortcode} is not this facility's` : null,
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
    logger.error({ err, facilityId: settings.facilityId, transactionId: parsed.transactionId }, "Failed to store an M-Pesa confirmation");
    throw err;
  }
  if (foreign) {
    logger.error({ facilityId: settings.facilityId, transactionId: parsed.transactionId }, "M-Pesa confirmation for another paybill");
    return { status: 200, body: ACCEPTED };
  }

  try {
    await runAsFacility(settings.facilityId, tx => matchTransaction(tx, settings.facilityId, id));
  }
  catch (err) {
    // Stored and unmatched: it waits in the queue for a person.
    logger.error({ err, facilityId: settings.facilityId, transactionId: parsed.transactionId }, "Failed to match an M-Pesa confirmation");
  }
  return { status: 200, body: ACCEPTED };
}

/**
 * Validation runs before the payer's money moves, and refusing would fail
 * their payment at the till. A reference we do not know is the normal case,
 * so every payment is accepted, even for an unknown token.
 */
export async function onC2bValidation(token: string): Promise<CallbackAnswer> {
  if (!await facilityForToken(token))
    logger.warn({ tokenPrefix: token.slice(0, 6) }, "M-Pesa validation for an unknown callback token; accepted");
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
  if (!parsed) {
    logger.error({ facilityId: settings.facilityId }, "Unparseable M-Pesa prompt callback");
    return { status: 200, body: ACCEPTED };
  }
  const outcome = await runAsFacility(settings.facilityId, tx => completeStkPush(tx, settings.facilityId, settings.shortcode, parsed, payload));
  if (outcome === "unusable")
    logger.error({ facilityId: settings.facilityId }, "M-Pesa prompt callback reported success without a receipt or amount");
  return { status: 200, body: ACCEPTED };
}
