import { and, asc, eq, isNull, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { gatewayExchanges, mpesaCallbackReplays, mpesaSettings } from "@/db/schema";

import type { PatientActor } from "./patients";

import { recordAudit } from "./audit";
import { parseStkCallback } from "./daraja";
import { errorLine } from "./error-summary";
import { logger } from "./logger";
import { MpesaError } from "./mpesa";
import { recordStkCallback, settleStkCallback } from "./mpesa-stk";

/**
 * Prompt callbacks that could not be recorded when they came (ROADMAP.md
 * P6). Safaricom does not call back again, so such a callback is kept in
 * `gateway_exchanges` as "Could not be recorded" (lib/mpesa-callbacks.ts).
 * Finance replays it through the same steps as the first attempt: a receipt
 * already on file is never booked twice, and the money lands on its prompt
 * or in the queue for a person. A callback that could not be read is not
 * here: nothing can be replayed from it, and it stays for a person to read.
 */

/** What the first attempt left as "Could not be recorded". */
export const NOT_RECORDED = "Could not be recorded";

export interface UnrecordedCallback {
  id: string;
  receivedAt: Date;
  /** Whether Safaricom said the payer paid. */
  paid: boolean;
  receiptNumber: string | null;
  amountCents: number | null;
}

/** The callbacks waiting to be replayed, oldest first. Receipt numbers and amounts only: no payer's name or phone. */
export async function listUnrecordedCallbacks(tx: AppDb): Promise<UnrecordedCallback[]> {
  const rows = await tx
    .select({ id: gatewayExchanges.id, receivedAt: gatewayExchanges.createdAt, response: gatewayExchanges.response })
    .from(gatewayExchanges)
    .leftJoin(mpesaCallbackReplays, eq(mpesaCallbackReplays.exchangeId, gatewayExchanges.id))
    .where(and(eq(gatewayExchanges.operation, "stk_callback"), eq(gatewayExchanges.error, NOT_RECORDED), isNull(mpesaCallbackReplays.exchangeId)))
    .orderBy(asc(gatewayExchanges.createdAt), asc(gatewayExchanges.id))
    .limit(200);
  return rows.map((row) => {
    const callback = parseStkCallback(row.response);
    return {
      id: row.id,
      receivedAt: row.receivedAt,
      paid: callback?.resultCode === 0,
      receiptNumber: callback?.receiptNumber ?? null,
      amountCents: callback?.amountCents ?? null,
    };
  });
}

export type ReplayOutcome = "paid" | "queued" | "failed" | "unusable";

/**
 * Replays one kept callback, once. Placing its money is a savepoint of its
 * own, as it is a second transaction for a callback that just came: if that
 * fails, the money is recorded all the same and waits in the queue.
 */
export async function replayCallback(tx: AppDb, facilityId: string, exchangeId: string, actor: PatientActor): Promise<ReplayOutcome> {
  // One replay of a callback at a time: the second waits, then finds the first's record.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mpesa_replay:${facilityId}:${exchangeId}`}, 0))`);
  const [kept] = await tx
    .select({ response: gatewayExchanges.response, replayed: mpesaCallbackReplays.exchangeId })
    .from(gatewayExchanges)
    .leftJoin(mpesaCallbackReplays, eq(mpesaCallbackReplays.exchangeId, gatewayExchanges.id))
    .where(and(eq(gatewayExchanges.id, exchangeId), eq(gatewayExchanges.operation, "stk_callback"), eq(gatewayExchanges.error, NOT_RECORDED)))
    .limit(1);
  const callback = kept && parseStkCallback(kept.response);
  if (!kept || !callback)
    throw new MpesaError("callback_not_found");
  if (kept.replayed)
    throw new MpesaError("already_replayed");
  const [settings] = await tx.select({ shortcode: mpesaSettings.shortcode }).from(mpesaSettings).limit(1);
  if (!settings)
    throw new MpesaError("not_set_up");

  const recorded = await recordStkCallback(tx, facilityId, settings.shortcode, callback, kept.response);
  let outcome: ReplayOutcome = recorded.outcome === "settle" ? "queued" : recorded.outcome;
  if (recorded.outcome === "settle") {
    try {
      outcome = await tx.transaction(sp => settleStkCallback(sp, facilityId, recorded.requestId, recorded.transactionId));
    }
    catch (err) {
      // Recorded, not placed: it waits in the queue, as after a callback that just came.
      logger.error({ error: errorLine(err), facilityId, transactionId: callback.receiptNumber }, "Failed to place a replayed M-Pesa prompt's payment; it waits in the queue");
      outcome = "queued";
    }
  }

  await tx.insert(mpesaCallbackReplays).values({ facilityId, exchangeId, replayedBy: actor.membershipId, outcome });
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "mpesa.callback_replayed",
    entityType: "gateway_exchange",
    entityId: exchangeId,
    summary: callback.receiptNumber ? `Replayed the M-Pesa prompt callback for ${callback.receiptNumber}` : "Replayed an M-Pesa prompt callback",
    detail: { outcome, receiptNumber: callback.receiptNumber, amountCents: callback.amountCents },
  });
  return outcome;
}
