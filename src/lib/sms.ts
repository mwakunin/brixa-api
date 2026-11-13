import { z } from "zod";

import env from "@/env";

/**
 * SMS through Africa's Talking, behind one interface so the provider can
 * change in one file (CLAUDE.md §2). Ported from school-saas-api's
 * lib/sms.ts.
 *
 * This module only talks to the provider. Who gets a message, what it says,
 * and the row that records it belong to the caller, which sends through the
 * outbox (rule 18): never inside a tenant transaction.
 *
 * One account for the platform, from the environment (decided 2026-11-13).
 * Until its credentials are configured, callers skip what falls due.
 */

export const smsEnabled = Boolean(env.AT_USERNAME && env.AT_API_KEY);

/**
 * Whether a caller should attempt to send: under test `sendSms` captures into
 * `sentSms`, so senders must still run, or nothing about them is exercised.
 */
export const smsDeliverable = smsEnabled || env.NODE_ENV === "test";

/** Long enough for the API, short enough that a drain cannot hang on one call. */
const SEND_TIMEOUT_MS = 15_000;

/** Test seam: messages captured instead of sent when NODE_ENV=test. */
export const sentSms: Array<{ to: string; body: string; from?: string }> = [];

export class SmsError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "SmsError";
  }
}

/** What Africa's Talking says happened to the one recipient. */
export interface SmsResult {
  accepted: boolean;
  /** Africa's Talking's id, which a delivery report would name. */
  providerMessageId: string | null;
  /** Cents: a message costs a fraction of a shilling. */
  costCents: number | null;
  /** Why it was refused. */
  reason: string | null;
}

function baseUrl(): string {
  return env.AT_ENV === "production"
    ? "https://api.africastalking.com"
    : "https://api.sandbox.africastalking.com";
}

/**
 * Africa's Talking quotes cost as `"KES 0.8000"`, or `"0"` when free. Parsed
 * rather than trusted as a number, because the currency is part of the field.
 */
export function parseCostCents(raw: unknown): number | null {
  if (typeof raw === "number")
    return Number.isFinite(raw) && raw >= 0 ? Math.round(raw * 100) : null;
  if (typeof raw !== "string")
    return null;
  const match = raw.match(/\d+(?:\.\d+)?/);
  if (!match)
    return null;
  const amount = Number(match[0]);
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

/** 100 Processed, 101 Sent and 102 Queued all mean Africa's Talking took the message. */
const ACCEPTED = new Set([100, 101, 102]);

/** The answer as Africa's Talking documents it; anything else is not an answer this code can trust. */
const AnswerSchema = z.object({
  SMSMessageData: z.object({
    Message: z.string().optional(),
    Recipients: z.array(z.object({
      statusCode: z.number().int(),
      status: z.string().optional(),
      messageId: z.string().optional(),
      cost: z.union([z.string(), z.number()]).optional(),
    })),
  }),
});

/**
 * Reads Africa's Talking's answer for the one recipient. One that does not
 * have the documented shape throws, so the send is retried rather than
 * recorded as refused.
 */
export function resultOf(payload: unknown): SmsResult {
  const parsed = AnswerSchema.safeParse(payload);
  if (!parsed.success)
    throw new SmsError("Africa's Talking's answer was not in the expected shape");
  const data = parsed.data.SMSMessageData;
  const recipient = data.Recipients[0];
  // No recipient entry: the request was refused outright (a sender not
  // registered, no balance, a malformed number).
  if (!recipient)
    return { accepted: false, providerMessageId: null, costCents: null, reason: (data.Message || "Refused with no recipient detail").slice(0, 200) };
  const accepted = ACCEPTED.has(recipient.statusCode);
  return {
    accepted,
    providerMessageId: recipient.messageId ?? null,
    costCents: parseCostCents(recipient.cost),
    reason: accepted ? null : (recipient.status || `Status ${recipient.statusCode}`).slice(0, 200),
  };
}

/**
 * Sends one message to one number. Throws `SmsError` when Africa's Talking
 * could not be reached or answered with an error, so the outbox retries; a
 * refusal for this recipient is an answer, returned rather than thrown.
 */
export async function sendSms(input: { to: string; body: string; from?: string }): Promise<SmsResult> {
  if (env.NODE_ENV === "test") {
    sentSms.push(input);
    return { accepted: true, providerMessageId: `test-${sentSms.length}`, costCents: 80, reason: null };
  }
  if (!smsEnabled)
    throw new SmsError("SMS is not configured (AT_USERNAME / AT_API_KEY)");

  const form = new URLSearchParams({
    username: env.AT_USERNAME!,
    to: input.to,
    message: input.body,
    ...(input.from ? { from: input.from } : {}),
  });

  let response: Response;
  try {
    response = await fetch(`${baseUrl()}/version1/messaging`, {
      method: "POST",
      headers: {
        "apiKey": env.AT_API_KEY!,
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      // The request carries the API key in a custom header, which `fetch`
      // would hand to another host on a redirect. Africa's Talking has no
      // reason to redirect this POST.
      redirect: "error",
    });
  }
  catch (err) {
    throw new SmsError("Could not reach Africa's Talking", err);
  }

  // Checked before parsing: a gateway error comes back as HTML.
  if (!response.ok)
    throw new SmsError(`Africa's Talking returned ${response.status}`);

  let payload: unknown;
  try {
    payload = await response.json();
  }
  catch (err) {
    throw new SmsError("Africa's Talking's answer could not be read", err);
  }
  return resultOf(payload);
}
