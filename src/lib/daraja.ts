import { Buffer } from "node:buffer";

import env from "@/env";

/**
 * Safaricom's Daraja API: the HTTP calls and the parsing of what Safaricom
 * sends back (ported from school-saas-api's mpesa.ts and mpesa-c2b.ts, with
 * credentials per facility). Nothing here touches the database or runs
 * inside a tenant transaction (rule 18); callers record each exchange in
 * `gateway_exchanges` afterwards.
 */

const HOSTS = {
  sandbox: "https://sandbox.safaricom.co.ke",
  production: "https://api.safaricom.co.ke",
} as const;

export const DARAJA_TIMEOUT_MS = 30_000;

export function baseUrl(): string {
  return HOSTS[env.MPESA_ENV];
}

/**
 * A Daraja call that failed. `definitive` means Safaricom answered and
 * refused, so repeating the call cannot help; otherwise the outcome is
 * unknown (a timeout, a 5xx).
 */
export class DarajaError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: unknown, readonly definitive = false) {
    super(message);
    this.name = "DarajaError";
  }
}

/** A facility's decrypted credentials. Never logged, never returned. */
export interface DarajaCredentials {
  consumerKey: string;
  consumerSecret: string;
  /** For STK push; Safaricom issues it with the paybill's Lipa na M-Pesa Online. */
  passkey: string;
}

// One token per consumer key: two facilities never share a slot unless they share a key.
const tokens = new Map<string, { value: string; expiresAt: number }>();

export function resetDarajaTokens() {
  tokens.clear();
}

async function accessToken(credentials: DarajaCredentials): Promise<string> {
  const cached = tokens.get(credentials.consumerKey);
  if (cached && Date.now() < cached.expiresAt)
    return cached.value;

  const basic = Buffer.from(`${credentials.consumerKey}:${credentials.consumerSecret}`).toString("base64");
  const res = await fetch(`${baseUrl()}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${basic}` },
    signal: AbortSignal.timeout(DARAJA_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: string };
  if (!res.ok || !body.access_token)
    throw new DarajaError(`Daraja token request failed (${res.status})`, res.status, undefined, res.status === 400 || res.status === 401);

  const ttlSeconds = Number(body.expires_in ?? 3599);
  // A minute of headroom, so a token never expires in flight.
  tokens.set(credentials.consumerKey, { value: body.access_token, expiresAt: Date.now() + Math.max(ttlSeconds - 60, 0) * 1000 });
  return body.access_token;
}

/** What a call sent (without secrets) and what came back, for `gateway_exchanges`. */
export interface Exchange {
  request: Record<string, unknown>;
  response: Record<string, unknown>;
  httpStatus: number;
}

async function post(path: string, credentials: DarajaCredentials, body: Record<string, unknown>) {
  const token = await accessToken(credentials);
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(DARAJA_TIMEOUT_MS),
    body: JSON.stringify(body),
  });
  const response = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { res, response };
}

function refused(what: string, res: Response, response: Record<string, unknown>): DarajaError {
  const message = typeof response.errorMessage === "string" ? response.errorMessage : `${what} refused (${res.status})`;
  // An answer with a business code, or a 4xx, is Safaricom's decision; a 5xx is not.
  const definitive = (res.status >= 400 && res.status < 500) || (res.ok && response.ResponseCode !== undefined);
  return new DarajaError(message, res.status, response, definitive);
}

/**
 * Tells Safaricom where to send this paybill's confirmations. "Completed"
 * means a payment still completes when our validation URL is unreachable:
 * our outage must never become a patient's failed payment.
 */
export async function registerC2bUrls(input: {
  shortcode: string;
  credentials: DarajaCredentials;
  confirmationUrl: string;
  validationUrl: string;
}): Promise<Exchange> {
  const request = {
    ShortCode: input.shortcode,
    ResponseType: "Completed",
    ConfirmationURL: input.confirmationUrl,
    ValidationURL: input.validationUrl,
  };
  const { res, response } = await post("/mpesa/c2b/v1/registerurl", input.credentials, request);
  if (!res.ok || String(response.ResponseCode ?? "") !== "0")
    throw Object.assign(refused("URL registration", res, response), { exchange: { request, response, httpStatus: res.status } });
  return { request, response, httpStatus: res.status };
}

/** Daraja's timestamp: `YYYYMMDDHHmmss` in East Africa Time. */
export function darajaTimestamp(now: Date = new Date()): string {
  const eat = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const p = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${p(eat.getUTCFullYear(), 4)}${p(eat.getUTCMonth() + 1)}${p(eat.getUTCDate())}${p(eat.getUTCHours())}${p(eat.getUTCMinutes())}${p(eat.getUTCSeconds())}`;
}

export function stkPassword(shortcode: string, passkey: string, timestamp: string): string {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");
}

/**
 * Prompts a phone to pay the facility's paybill. The request recorded for
 * the exchange leaves out the password, which is derived from the passkey.
 */
export async function stkPush(input: {
  shortcode: string;
  credentials: DarajaCredentials;
  callbackUrl: string;
  /** E.164, `+2547…`. */
  phone: string;
  amountCents: number;
  accountReference: string;
  description: string;
}): Promise<Exchange & { checkoutRequestId: string; merchantRequestId: string }> {
  if (input.amountCents % 100 !== 0)
    throw new DarajaError(`${input.amountCents} is not a whole number of shillings`, undefined, undefined, true);

  const timestamp = darajaTimestamp();
  const msisdn = input.phone.replace(/^\+/, "");
  const request = {
    BusinessShortCode: input.shortcode,
    Timestamp: timestamp,
    TransactionType: "CustomerPayBillOnline",
    Amount: input.amountCents / 100,
    PartyA: msisdn,
    PartyB: input.shortcode,
    PhoneNumber: msisdn,
    CallBackURL: input.callbackUrl,
    AccountReference: input.accountReference.slice(0, 12),
    TransactionDesc: input.description.slice(0, 13),
  };
  const { res, response } = await post("/mpesa/stkpush/v1/processrequest", input.credentials, {
    ...request,
    Password: stkPassword(input.shortcode, input.credentials.passkey, timestamp),
  });
  if (!res.ok || String(response.ResponseCode ?? "") !== "0")
    throw Object.assign(refused("STK push", res, response), { exchange: { request, response, httpStatus: res.status } });
  return {
    request,
    response,
    httpStatus: res.status,
    checkoutRequestId: String(response.CheckoutRequestID ?? ""),
    merchantRequestId: String(response.MerchantRequestID ?? ""),
  };
}

/** The exchange a failed call carried, if Safaricom answered at all. */
export function exchangeOf(err: unknown): Exchange | null {
  return (err as { exchange?: Exchange })?.exchange ?? null;
}

// ---------------------------------------------------------------------------
// What Safaricom sends
// ---------------------------------------------------------------------------

/**
 * Daraja's `TransTime`, `YYYYMMDDHHmmss` in East Africa Time (UTC+3, no DST).
 * Built from its parts and read back, so an impossible date (month 13)
 * fails instead of rolling over to a plausible wrong one.
 */
export function parseTransTime(value: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value.trim());
  if (!match)
    return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const wall = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const exact = wall.getUTCFullYear() === year && wall.getUTCMonth() === month - 1 && wall.getUTCDate() === day
    && wall.getUTCHours() === hour && wall.getUTCMinutes() === minute && wall.getUTCSeconds() === second;
  return exact ? new Date(wall.getTime() - 3 * 60 * 60 * 1000) : null;
}

/** A paybill payment as Safaricom confirms it. */
export interface C2bConfirmation {
  transactionId: string;
  shortcode: string;
  accountReference: string | null;
  /** As Safaricom sends it: since 2023 often masked or hashed. */
  msisdn: string;
  payerName: string | null;
  amountCents: number;
  transactedAt: Date;
}

function text(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  if (typeof value === "string" && value.trim() !== "")
    return value.trim();
  if (typeof value === "number")
    return String(value);
  return null;
}

/**
 * Shapes a C2B confirmation, believing nothing: the payload is
 * unauthenticated. Null when a field the record cannot exist without is
 * missing or unusable, including a fractional amount (whole shillings only).
 */
export function parseC2bConfirmation(payload: unknown): C2bConfirmation | null {
  if (typeof payload !== "object" || payload === null)
    return null;
  const body = payload as Record<string, unknown>;
  const transactionId = text(body, "TransID");
  const shortcode = text(body, "BusinessShortCode");
  const msisdn = text(body, "MSISDN");
  const transTime = text(body, "TransTime");
  const shillings = Number(text(body, "TransAmount"));
  if (!transactionId || !shortcode || !msisdn || !transTime || !Number.isFinite(shillings) || shillings <= 0)
    return null;
  const amountCents = Math.round(shillings * 100);
  const transactedAt = parseTransTime(transTime);
  if (amountCents % 100 !== 0 || !transactedAt)
    return null;
  const names = ["FirstName", "MiddleName", "LastName"].map(key => text(body, key)).filter((n): n is string => n !== null);
  return {
    transactionId,
    shortcode,
    accountReference: text(body, "BillRefNumber"),
    msisdn,
    payerName: names.length > 0 ? names.join(" ") : null,
    amountCents,
    transactedAt,
  };
}

/** An STK push's outcome, as Safaricom calls back with it. */
export interface StkCallback {
  checkoutRequestId: string;
  resultCode: number;
  resultDesc: string;
  receiptNumber: string | null;
  amountCents: number | null;
  phone: string | null;
  transactedAt: Date | null;
}

export function parseStkCallback(payload: unknown): StkCallback | null {
  const stk = (payload as { Body?: { stkCallback?: Record<string, unknown> } })?.Body?.stkCallback;
  if (!stk || typeof stk !== "object" || typeof stk.CheckoutRequestID !== "string" || stk.CheckoutRequestID === "")
    return null;
  const items = (stk.CallbackMetadata as { Item?: { Name?: unknown; Value?: unknown }[] } | undefined)?.Item;
  const pick = (name: string) => (Array.isArray(items) ? items.find(i => i.Name === name)?.Value : undefined);
  const amount = pick("Amount");
  const receipt = pick("MpesaReceiptNumber");
  const phone = pick("PhoneNumber");
  const when = pick("TransactionDate");
  return {
    checkoutRequestId: stk.CheckoutRequestID,
    resultCode: Number(stk.ResultCode ?? -1),
    resultDesc: typeof stk.ResultDesc === "string" ? stk.ResultDesc : "",
    receiptNumber: typeof receipt === "string" && receipt !== "" ? receipt : null,
    amountCents: typeof amount === "number" ? Math.round(amount * 100) : null,
    phone: phone != null ? String(phone) : null,
    transactedAt: when != null ? parseTransTime(String(when)) : null,
  };
}

/** Advisory: an unlisted source is logged, never refused. */
export function isListedCallbackSource(ip: string | undefined): boolean {
  const listed = env.MPESA_CALLBACK_ALLOWED_IPS?.split(",").map(s => s.trim()).filter(Boolean) ?? [];
  return listed.length === 0 || (ip !== undefined && listed.includes(ip));
}
