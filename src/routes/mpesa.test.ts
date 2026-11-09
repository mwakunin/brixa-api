import { eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Hospital, Person } from "@/test/hospital";

import app from "@/app";
import db, { appDb, pool } from "@/db";
import { admissions, auditLog, documents, gatewayExchanges, mpesaSettings, mpesaTransactions, normalisedNumber, outbox, patientNumbers, payments, stkCheckoutId } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import { drainOutbox, MAX_ATTEMPTS } from "@/jobs/outbox-worker";
import { darajaTimestamp, resetDarajaTokens } from "@/lib/daraja";
import { recordSent } from "@/lib/mpesa-stk";
import { backendPid, resetDb, waitForBlockedBackend } from "@/test/helpers";
import { call, hospital, TODAY } from "@/test/hospital";

/** The Kenyan year now: read when used, since TODAY is re-read for each test. */
const year = () => TODAY.slice(0, 4);
const PAYBILL = "600123";

let h: Hospital;
let token: string;

beforeEach(async () => {
  await resetDb();
  resetDarajaTokens();
  h = await hospital();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function refusal(res: Response) {
  return [res.status, (await res.json()).code];
}

/** A stand-in for Safaricom: tokens always, the rest as each test says. */
function daraja(answers: { register?: () => Response; stk?: () => Response } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/oauth/v1/generate"))
      return Response.json({ access_token: "daraja-token", expires_in: "3599" });
    if (url.includes("/mpesa/c2b/v1/registerurl"))
      return answers.register?.() ?? Response.json({ ResponseCode: "0", ResponseDescription: "Success" });
    if (url.includes("/mpesa/stkpush/v1/processrequest"))
      return answers.stk?.() ?? Response.json({ ResponseCode: "0", MerchantRequestID: "m-1", CheckoutRequestID: "ws_CO_1", CustomerMessage: "Success" });
    throw new Error(`Unexpected call to ${url}`);
  });
}

async function setUp() {
  const res = await call("PUT", "/mpesa/settings", h.facility.id, h.admin, {
    shortcode: PAYBILL,
    consumerKey: "consumer-key-1",
    consumerSecret: "consumer-secret-1",
    passkey: "stk-passkey-1",
  });
  expect(res.status).toBe(200);
  const [row] = await db.select().from(mpesaSettings).where(eq(mpesaSettings.facilityId, h.facility.id));
  token = row.callbackToken;
  return res.json();
}

function post(path: string, body: unknown) {
  return app.request(`/webhooks/mpesa/${token}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

let receipts = 0;
/** A paybill confirmation as Safaricom sends it. */
function confirmation(over: Record<string, unknown> = {}) {
  receipts += 1;
  return {
    TransactionType: "Pay Bill",
    TransID: `SKL${String(receipts).padStart(7, "0")}`,
    TransTime: darajaTimestamp(),
    TransAmount: "600.00",
    BusinessShortCode: PAYBILL,
    BillRefNumber: "",
    MSISDN: "254712345678",
    FirstName: "Jane",
    LastName: "Wanjiru",
    ...over,
  };
}

/** A patient's closed visit with a finalised KES 508 bill. */
async function billed(patientId: string) {
  const encounterId = (await (await call("POST", "/encounters", h.facility.id, h.nurse, { patientId, kind: "opd" })).json()).id;
  for (const [item, quantity] of [[h.items.consultation, "1"], [h.items.tablet, "3"]])
    await call("POST", `/encounters/${encounterId}/charges`, h.facility.id, h.clerk, { billableItemId: item, quantity, reason: "Before P3" });
  const invoiceId = (await (await call("POST", `/encounters/${encounterId}/invoices`, h.facility.id, h.clerk, { kind: "final" })).json()).id;
  await call("POST", `/invoices/${invoiceId}/finalise`, h.facility.id, h.clerk);
  await call("POST", `/encounters/${encounterId}/close`, h.facility.id, h.nurse);
  return invoiceId as string;
}

const invoice = async (id: string) => (await call("GET", `/invoices/${id}`, h.facility.id, h.finance)).json();
async function checkoutOfExchange(id: string) {
  const [row] = await db.select({ checkout: stkCheckoutId(gatewayExchanges.response) }).from(gatewayExchanges).where(eq(gatewayExchanges.id, id));
  return row?.checkout;
}
async function paymentOf(transactionId: string) {
  return (await db.select().from(payments).innerJoin(mpesaTransactions, eq(mpesaTransactions.id, payments.mpesaTransactionId)).where(eq(mpesaTransactions.transactionId, transactionId)))[0]?.payments;
}

describe("m-Pesa settings", () => {
  it("are the facility admin's, stored encrypted, and registered with Safaricom in the background", async () => {
    expect((await call("PUT", "/mpesa/settings", h.facility.id, h.finance, { shortcode: PAYBILL, consumerKey: "k-12345678", consumerSecret: "s-12345678", passkey: "p-12345678" })).status).toBe(403);
    const { settings } = await setUp();

    expect(settings).toMatchObject({ shortcode: PAYBILL, urlsRegisteredAt: null });
    expect(settings.callbackUrls.confirmation).toContain(`/webhooks/mpesa/${token}/c2b/confirmation`);
    expect(JSON.stringify(settings)).not.toContain("consumer-secret-1");
    const [row] = await db.select().from(mpesaSettings);
    expect(row.credentials).not.toContain("consumer-secret-1");
    expect(await db.select({ operation: outbox.operation }).from(outbox)).toEqual([{ operation: "mpesa.register_urls" }]);

    daraja();
    expect(await drainOutbox()).toMatchObject({ done: 1 });
    const after = (await (await call("GET", "/mpesa/settings", h.facility.id, h.admin)).json()).settings;
    expect(after.urlsRegisteredAt).toEqual(expect.any(String));
    const [exchange] = await db.select().from(gatewayExchanges);
    expect(exchange).toMatchObject({ operation: "register_urls", httpStatus: 200, error: null });
    expect(JSON.stringify(exchange.request)).not.toMatch(/consumer-secret-1|stk-passkey-1/);
    expect(JSON.stringify(exchange.request)).not.toContain(token);
    expect(exchange.request).toMatchObject({ ConfirmationURL: expect.stringContaining("/webhooks/mpesa/[token]/") });
  });

  it("show Safaricom's refusal to the admin, and try again later", async () => {
    await setUp();
    daraja({ register: () => Response.json({ errorMessage: "Invalid ShortCode" }, { status: 400 }) });

    expect(await drainOutbox()).toMatchObject({ retried: 1 });

    const { settings } = await (await call("GET", "/mpesa/settings", h.facility.id, h.admin)).json();
    expect(settings).toMatchObject({ urlsRegisteredAt: null, lastRegistrationError: expect.stringContaining("Invalid ShortCode") });
  });
});

describe("paybill payments", () => {
  beforeEach(async () => {
    await setUp();
  });

  it("naming a bill settle it, however the number is typed", async () => {
    const patientId = await h.patient();
    const invoiceId = await billed(patientId);

    const res = await post("/c2b/confirmation", confirmation({ BillRefNumber: `inv ${year()}/000001`, TransAmount: "508.00" }));

    expect(await res.json()).toEqual({ ResultCode: 0, ResultDesc: "Accepted" });
    expect(await invoice(invoiceId)).toMatchObject({ paidCents: 50_800, balanceCents: 0 });
    const [transaction] = await db.select().from(mpesaTransactions);
    expect(transaction).toMatchObject({ status: "allocated", msisdn: "+254712345678", amountCents: 50_800 });
    const payment = await paymentOf(transaction.transactionId);
    expect(payment).toMatchObject({ method: "mpesa_c2b", receivedBy: null, reference: transaction.transactionId });
    const [receipt] = await db.select().from(documents).where(eq(documents.id, payment.documentId));
    expect(receipt.content.fields).toContainEqual({ label: "Paid by", value: "M-Pesa" });
    const [received] = await db.select().from(auditLog).where(eq(auditLog.action, "mpesa.received"));
    expect(received.actorId).toBeNull();
  });

  it("naming an admission are its deposit, and naming a patient are credit", async () => {
    const admitted = await h.patient();
    const { id: encounterId } = await (await call("POST", "/admissions", h.facility.id, h.nurse, { patientId: admitted, bedId: h.beds.general })).json();
    const walkIn = await h.patient();
    const [op] = (await pool.query("SELECT number FROM patient_numbers WHERE patient_id = $1 AND kind = 'outpatient'", [walkIn])).rows;

    await post("/c2b/confirmation", confirmation({ TransID: "SKADM00001", BillRefNumber: `ADM-${year()}-0001` }));
    await post("/c2b/confirmation", confirmation({ TransID: "SKOPD00001", BillRefNumber: op.number.toLowerCase() }));

    expect(await paymentOf("SKADM00001")).toMatchObject({ encounterId });
    const credit = await paymentOf("SKOPD00001");
    expect(credit).toMatchObject({ encounterId: null });
    expect((await (await call("GET", `/patients/${walkIn}/account`, h.facility.id, h.cashier)).json()).creditCents).toBe(60_000);
  });

  it("matching nothing wait in the queue, where a biller places them and finance sets them aside", async () => {
    const patientId = await h.patient();
    const invoiceId = await billed(patientId);
    await post("/c2b/confirmation", confirmation({ TransID: "SKUNKNOWN1", BillRefNumber: "Jane W" }));
    await post("/c2b/confirmation", confirmation({ TransID: "SKUNKNOWN2" }));

    const listed = await (await call("GET", "/mpesa/transactions?status=unmatched", h.facility.id, h.clerk)).json();
    // Both arrived within the same second, so either may be listed first.
    expect(listed.transactions.map((t: { transactionId: string; statusReason: string }) => [t.transactionId, t.statusReason]).sort()).toEqual([
      ["SKUNKNOWN1", "No bill, admission or patient has this number"],
      ["SKUNKNOWN2", "No account number was given"],
    ]);
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "mpesa.listed"))).toHaveLength(1);
    const found = await (await call("GET", "/mpesa/transactions?transactionId=skunknown1", h.facility.id, h.clerk)).json();
    expect(found.transactions.map((t: { transactionId: string }) => t.transactionId)).toEqual(["SKUNKNOWN1"]);
    const nextPage = await (await call("GET", "/mpesa/transactions?status=unmatched&offset=1", h.facility.id, h.clerk)).json();
    expect(nextPage.transactions).toHaveLength(1);
    expect((await call("GET", "/mpesa/transactions", h.facility.id, h.nurse)).status).toBe(403);

    const [first] = await db.select().from(mpesaTransactions).where(eq(mpesaTransactions.transactionId, "SKUNKNOWN1"));
    const placed = await call("POST", `/mpesa/transactions/${first.id}/assign`, h.facility.id, h.clerk, { patientId, invoiceId });
    expect(await placed.json()).toMatchObject({ status: "allocated", paymentId: expect.any(String) });
    expect(await paymentOf("SKUNKNOWN1")).toMatchObject({ receivedBy: h.clerk.actor.membershipId });
    expect(await invoice(invoiceId)).toMatchObject({ balanceCents: 0 });
    expect(await refusal(await call("POST", `/mpesa/transactions/${first.id}/assign`, h.facility.id, h.clerk, { patientId }))).toEqual([409, "not_unmatched"]);

    const [second] = await db.select().from(mpesaTransactions).where(eq(mpesaTransactions.transactionId, "SKUNKNOWN2"));
    expect((await call("POST", `/mpesa/transactions/${second.id}/reject`, h.facility.id, h.clerk, { reason: "Paid in error" })).status).toBe(403);
    expect(await (await call("POST", `/mpesa/transactions/${second.id}/reject`, h.facility.id, h.finance, { reason: "Paid in error" })).json())
      .toMatchObject({ status: "rejected", statusReason: "Paid in error" });
  });

  it("naming a number two patients share, once normalised, wait for a person", async () => {
    const first = await h.patient();
    const other = await h.patient();
    const [op] = (await pool.query("SELECT number FROM patient_numbers WHERE patient_id = $1 AND kind = 'outpatient'", [first])).rows;
    // The same number written another way, on another patient.
    await pool.query("INSERT INTO patient_numbers (facility_id, patient_id, kind, number) VALUES ($1, $2, 'inpatient', $3)", [h.facility.id, other, op.number.replace(/(\D+)(\d+)/, "$1-$2")]);

    await post("/c2b/confirmation", confirmation({ TransID: "SKSHARED01", BillRefNumber: op.number }));

    const [transaction] = await db.select().from(mpesaTransactions);
    expect(transaction).toMatchObject({ status: "unmatched", statusReason: "More than one record has this number" });
    expect(await paymentOf("SKSHARED01")).toBeUndefined();
  });

  it("naming a bill whose number is also another patient's, once normalised, wait for a person", async () => {
    const patientId = await h.patient();
    await billed(patientId);
    const other = await h.patient();
    await pool.query("INSERT INTO patient_numbers (facility_id, patient_id, kind, number) VALUES ($1, $2, 'inpatient', $3)", [h.facility.id, other, `INV${year()}000001`]);

    await post("/c2b/confirmation", confirmation({ TransID: "SKCROSS001", TransAmount: "508.00", BillRefNumber: `INV-${year()}-000001` }));

    const [transaction] = await db.select().from(mpesaTransactions);
    expect(transaction).toMatchObject({ status: "unmatched", statusReason: "More than one record has this number" });
    expect(await paymentOf("SKCROSS001")).toBeUndefined();
  });

  it("are recorded once however often Safaricom repeats them", async () => {
    const body = confirmation({ TransID: "SKREPEAT01" });

    for (let i = 0; i < 3; i += 1)
      expect((await post("/c2b/confirmation", body)).status).toBe(200);
    // The same receipt in other letters is the same receipt.
    expect((await post("/c2b/confirmation", { ...body, TransID: "skrepeat01" })).status).toBe(200);

    expect(await db.select().from(mpesaTransactions)).toMatchObject([{ transactionId: "SKREPEAT01" }]);
  });

  it("for another paybill wait for a person, never matched by themselves", async () => {
    const patientId = await h.patient();
    const [op] = (await pool.query("SELECT number FROM patient_numbers WHERE patient_id = $1", [patientId])).rows;

    await post("/c2b/confirmation", confirmation({ TransID: "SKFOREIGN1", BusinessShortCode: "999999", BillRefNumber: op.number }));

    const [foreign] = await db.select().from(mpesaTransactions);
    expect(foreign).toMatchObject({ status: "unmatched", statusReason: "Paid to paybill 999999, not this facility's current one; check before placing it" });
    expect(await paymentOf("SKFOREIGN1")).toBeUndefined();
    expect((await call("POST", `/mpesa/transactions/${foreign.id}/assign`, h.facility.id, h.clerk, { patientId })).status).toBe(200);
  });

  it("are acknowledged however they arrive, and kept when they cannot be read", async () => {
    const validation = await app.request(`/webhooks/mpesa/${token}/c2b/validation`, { method: "POST" });
    expect(validation.status).toBe(200);
    // Even with the database unreachable: a failed lookup must not decline the payer's payment.
    vi.spyOn(db, "select").mockImplementationOnce(() => {
      throw new Error("connection refused");
    });
    const blind = await app.request(`/webhooks/mpesa/${token}/c2b/validation`, { method: "POST" });
    expect([blind.status, await blind.json()]).toEqual([200, { ResultCode: 0, ResultDesc: "Accepted" }]);
    expect((await post("/c2b/confirmation", ["not", "an", "object"])).status).toBe(200);
    expect((await post("/c2b/confirmation", { TransID: "SKBROKEN01" })).status).toBe(200);

    const kept = await db.select().from(gatewayExchanges).where(eq(gatewayExchanges.operation, "c2b_confirmation"));
    expect(kept.map(e => e.response)).toEqual([["not", "an", "object"], { TransID: "SKBROKEN01" }]);
    expect(await db.select().from(mpesaTransactions)).toHaveLength(0);

    token = "x".repeat(43);
    expect((await post("/c2b/confirmation", confirmation())).status).toBe(404);
    expect((await post("/c2b/validation", confirmation())).status).toBe(200);
  });

  it("return to the queue when their payment is reversed", async () => {
    const patientId = await h.patient();
    const [op] = (await pool.query("SELECT number FROM patient_numbers WHERE patient_id = $1", [patientId])).rows;
    await post("/c2b/confirmation", confirmation({ TransID: "SKREVERSE1", BillRefNumber: op.number }));
    const payment = await paymentOf("SKREVERSE1");

    const reversed = await call("POST", `/payments/${payment.id}/reverse`, h.facility.id, h.finance, { reason: "Wrong patient" });

    expect(reversed.status).toBe(200);
    const [transaction] = await db.select().from(mpesaTransactions);
    expect(transaction).toMatchObject({ status: "unmatched", statusReason: "Returned to the queue when its payment was reversed" });
  });
});

describe("m-Pesa prompts", () => {
  const prompt = (body: Record<string, unknown>, as: Person = h.cashier) => call("POST", "/mpesa/stk", h.facility.id, as, body);
  const callback = (body: Record<string, unknown>) => post("/stk/callback", { Body: { stkCallback: body } });
  const paid = (checkout: string, receipt: string, amount: number) => callback({
    MerchantRequestID: "m-1",
    CheckoutRequestID: checkout,
    ResultCode: 0,
    ResultDesc: "The service request is processed successfully.",
    CallbackMetadata: { Item: [
      { Name: "Amount", Value: amount },
      { Name: "MpesaReceiptNumber", Value: receipt },
      { Name: "TransactionDate", Value: Number(darajaTimestamp()) },
      { Name: "PhoneNumber", Value: 254712345678 },
    ] },
  });

  it("need M-Pesa set up and a Kenyan mobile number", async () => {
    const patientId = await h.patient();
    expect(await refusal(await prompt({ patientId, phone: "0712345678", amountCents: 10_000 }))).toEqual([409, "not_set_up"]);
    await setUp();
    expect(await refusal(await prompt({ patientId, phone: "0201234567", amountCents: 10_000 }))).toEqual([409, "phone_invalid"]);
    expect((await prompt({ patientId, phone: "0712345678", amountCents: 10_000 }, h.clerk)).status).toBe(403);
  });

  it("are sent through the outbox, and settle the bill when the patient pays", async () => {
    await setUp();
    const patientId = await h.patient();
    const invoiceId = await billed(patientId);

    const res = await prompt({ patientId, phone: "0712 345 678", amountCents: 50_800, invoiceId });
    expect(res.status).toBe(202);
    const request = await res.json();
    expect(request).toMatchObject({ status: "queued", phone: "+254712345678" });

    const fetch = daraja();
    await drainOutbox();
    const sent = JSON.parse(String(fetch.mock.calls.find(([url]) => String(url).includes("stkpush"))![1]!.body));
    // The last 12 characters of INV-YYYY-000001: unique per bill, unlike a prefix.
    expect(sent).toMatchObject({ PhoneNumber: "254712345678", Amount: 508, AccountReference: `NV${year()}000001` });
    expect((await (await call("GET", `/mpesa/stk/${request.id}`, h.facility.id, h.cashier)).json()).status).toBe("sent");
    const [exchange] = await db.select().from(gatewayExchanges).where(eq(gatewayExchanges.operation, "stk_push"));
    expect(exchange.request).not.toHaveProperty("Password");
    expect(JSON.stringify(exchange.request)).not.toContain(token);

    expect((await paid("ws_CO_1", "SKSTK00001", 508)).status).toBe(200);
    await paid("ws_CO_1", "SKSTK00001", 508);

    expect(await (await call("GET", `/mpesa/stk/${request.id}`, h.facility.id, h.cashier)).json())
      .toMatchObject({ status: "completed", receiptNumber: "SKSTK00001" });
    expect(await paymentOf("SKSTK00001")).toMatchObject({ method: "mpesa_stk", receivedBy: h.cashier.actor.membershipId });
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "mpesa.received"))).toMatchObject([{ actorId: null, detail: { source: "stk" } }]);
    expect((await db.select().from(auditLog).where(eq(auditLog.action, "mpesa.stk_viewed"))).length).toBeGreaterThan(0);
    expect(await invoice(invoiceId)).toMatchObject({ balanceCents: 0 });
    expect(await db.select().from(payments)).toHaveLength(1);

    const payment = await paymentOf("SKSTK00001");
    await call("POST", `/payments/${payment.id}/reverse`, h.facility.id, h.finance, { reason: "Wrong patient" });
    expect(await (await call("GET", `/mpesa/stk/${request.id}`, h.facility.id, h.cashier)).json())
      .toMatchObject({ status: "completed", paymentId: payment.id, paymentReversed: true });

    // Placed again by hand: the prompt now shows the live payment.
    const [transaction] = await db.select().from(mpesaTransactions).where(eq(mpesaTransactions.transactionId, "SKSTK00001"));
    const placed = await (await call("POST", `/mpesa/transactions/${transaction.id}/assign`, h.facility.id, h.clerk, { patientId, invoiceId })).json();
    expect(await (await call("GET", `/mpesa/stk/${request.id}`, h.facility.id, h.cashier)).json())
      .toMatchObject({ paymentId: placed.paymentId, paymentReversed: false });
  });

  it("complete their prompt when the paybill confirmation placed the payment first", async () => {
    await setUp();
    const patientId = await h.patient();
    const { id: encounterId } = await (await call("POST", "/admissions", h.facility.id, h.nurse, { patientId, bedId: h.beds.general })).json();
    const request = await (await prompt({ patientId, phone: "0712345678", amountCents: 100_000, encounterId })).json();
    daraja();
    await drainOutbox();

    // The admission number the phone showed matches by itself: the confirmation places the deposit.
    await post("/c2b/confirmation", confirmation({ TransID: "SKADMIT001", TransAmount: "1000.00", BillRefNumber: `ADM-${year()}-0001` }));
    expect(await paymentOf("SKADMIT001")).toMatchObject({ encounterId });
    await paid("ws_CO_1", "SKADMIT001", 1000);

    expect(await (await call("GET", `/mpesa/stk/${request.id}`, h.facility.id, h.cashier)).json()).toMatchObject({ status: "completed", receiptNumber: "SKADMIT001" });
    expect(await db.select().from(payments)).toHaveLength(1);
  });

  it("for an outpatient visit complete their prompt when the paybill confirmation placed the payment as credit first", async () => {
    await setUp();
    const patientId = await h.patient();
    const { id: encounterId } = await (await call("POST", "/encounters", h.facility.id, h.nurse, { patientId, kind: "opd" })).json();
    const request = await (await prompt({ patientId, phone: "0712345678", amountCents: 60_000, encounterId })).json();
    daraja();
    await drainOutbox();

    // A visit's prompt shows the patient's number, so its confirmation places patient credit, not a visit deposit.
    const [op] = (await pool.query("SELECT number FROM patient_numbers WHERE patient_id = $1 AND kind = 'outpatient'", [patientId])).rows;
    await post("/c2b/confirmation", confirmation({ TransID: "SKVISIT001", TransAmount: "600.00", BillRefNumber: op.number }));
    expect(await paymentOf("SKVISIT001")).toMatchObject({ encounterId: null });
    await paid("ws_CO_1", "SKVISIT001", 600);

    expect(await (await call("GET", `/mpesa/stk/${request.id}`, h.facility.id, h.cashier)).json()).toMatchObject({ status: "completed", receiptNumber: "SKVISIT001" });
    expect(await db.select().from(payments)).toHaveLength(1);
  });

  it("close their prompt when the paybill confirmation placed a different amount first", async () => {
    await setUp();
    const patientId = await h.patient();
    const { id: encounterId } = await (await call("POST", "/admissions", h.facility.id, h.nurse, { patientId, bedId: h.beds.general })).json();
    const request = await (await prompt({ patientId, phone: "0712345678", amountCents: 100_000, encounterId })).json();
    daraja();
    await drainOutbox();

    await post("/c2b/confirmation", confirmation({ TransID: "SKADMIT002", TransAmount: "600.00", BillRefNumber: `ADM-${year()}-0001` }));
    await paid("ws_CO_1", "SKADMIT002", 600);

    // Never left `sent`: the only payment there will be is named.
    expect(await (await call("GET", `/mpesa/stk/${request.id}`, h.facility.id, h.cashier)).json())
      .toMatchObject({ status: "failed", resultDesc: "Paid KES 600.00 instead, already placed as M-Pesa SKADMIT002" });
    expect(await db.select().from(payments)).toHaveLength(1);
  });

  it("close as failed when the patient declines, and are never sent twice", async () => {
    await setUp();
    const patientId = await h.patient();
    const declined = await (await prompt({ patientId, phone: "0712345678", amountCents: 10_000 })).json();
    daraja();
    await drainOutbox();

    await callback({ MerchantRequestID: "m-1", CheckoutRequestID: "ws_CO_1", ResultCode: 1032, ResultDesc: "Request cancelled by user" });
    expect(await (await call("GET", `/mpesa/stk/${declined.id}`, h.facility.id, h.cashier)).json())
      .toMatchObject({ status: "failed", resultDesc: "Request cancelled by user" });

    const unsent = await (await prompt({ patientId, phone: "0712345678", amountCents: 10_000 })).json();
    vi.restoreAllMocks();
    daraja({ stk: () => Response.json({ errorMessage: "Service unavailable" }, { status: 503 }) });
    expect(await drainOutbox()).toMatchObject({ done: 1, retried: 0 });
    expect((await (await call("GET", `/mpesa/stk/${unsent.id}`, h.facility.id, h.cashier)).json()).status).toBe("failed");
  });

  it("paid without a prompt on record wait in the queue, checkout id or not", async () => {
    await setUp();

    await paid("ws_CO_unknown", "SKSTRAY001", 300);
    await callback({ ResultCode: 0, ResultDesc: "Processed", CallbackMetadata: { Item: [{ Name: "Amount", Value: 200 }, { Name: "MpesaReceiptNumber", Value: "SKSTRAY002" }] } });

    const queued = await db.select().from(mpesaTransactions);
    expect(queued.map(t => [t.transactionId, t.source, t.status])).toEqual(expect.arrayContaining([
      ["SKSTRAY001", "stk", "unmatched"],
      ["SKSTRAY002", "stk", "unmatched"],
    ]));
  });

  it("settle their prompt even when the paybill confirmation of the same payment comes first", async () => {
    await setUp();
    const patientId = await h.patient();
    const invoiceId = await billed(patientId);
    const request = await (await prompt({ patientId, phone: "0712345678", amountCents: 50_800, invoiceId })).json();
    daraja();
    await drainOutbox();

    // The confirmation carries the shortened reference the phone showed, which names no bill by itself.
    await post("/c2b/confirmation", confirmation({ TransID: "SKBOTH0001", TransAmount: "508.00", BillRefNumber: `NV${year()}000001` }));
    expect(await paymentOf("SKBOTH0001")).toBeUndefined();
    await paid("ws_CO_1", "SKBOTH0001", 508);

    expect(await (await call("GET", `/mpesa/stk/${request.id}`, h.facility.id, h.cashier)).json()).toMatchObject({ status: "completed", receiptNumber: "SKBOTH0001" });
    expect(await invoice(invoiceId)).toMatchObject({ balanceCents: 0 });
    expect(await db.select().from(payments)).toHaveLength(1);
  });

  it("paid while the send is being recorded wait for it, then complete the prompt", async () => {
    await setUp();
    const patientId = await h.patient();
    const request = await (await prompt({ patientId, phone: "0712345678", amountCents: 10_000 })).json();
    const sent = { request: {}, response: {}, httpStatus: 200, checkoutRequestId: "ws_CO_race", merchantRequestId: "m-race" };

    // The send's write holds its transaction open, its checkout id not yet visible to anyone else.
    let pid = 0;
    let release!: () => void;
    let ready!: () => void;
    const mayCommit = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const sending = runAsFacility(h.facility.id, async (t) => {
      try {
        await recordSent(t, h.facility.id, request.id, sent);
        pid = await backendPid(t);
      }
      finally {
        ready();
        await mayCommit;
      }
    });
    await started;

    const callingBack = paid("ws_CO_race", "SKRACE0001", 100);
    try {
      // Without the shared lock the callback would not wait, and would queue the money as unknown.
      expect(await waitForBlockedBackend(pid)).toBe(true);
    }
    finally {
      release();
    }
    await sending;
    expect((await callingBack).status).toBe(200);

    expect(await (await call("GET", `/mpesa/stk/${request.id}`, h.facility.id, h.cashier)).json()).toMatchObject({ status: "completed", receiptNumber: "SKRACE0001" });
  });

  it("do not complete their prompt with a payment placed on another patient", async () => {
    await setUp();
    const patientId = await h.patient();
    const other = await h.patient();
    const [op] = (await pool.query("SELECT number FROM patient_numbers WHERE patient_id = $1 AND kind = 'outpatient'", [other])).rows;
    const request = await (await prompt({ patientId, phone: "0712345678", amountCents: 100_000 })).json();
    daraja();
    await drainOutbox();

    // Its paybill confirmation names the other patient, and is placed there first.
    await post("/c2b/confirmation", confirmation({ TransID: "SKOTHER001", TransAmount: "1000.00", BillRefNumber: op.number }));
    await paid("ws_CO_1", "SKOTHER001", 1000);

    expect(await (await call("GET", `/mpesa/stk/${request.id}`, h.facility.id, h.cashier)).json())
      .toMatchObject({ status: "failed", resultDesc: "Paid, but placed on another patient's account as M-Pesa SKOTHER001; check it" });
  });

  it("do not complete their prompt with a payment placed against another of the patient's bills", async () => {
    await setUp();
    const patientId = await h.patient();
    await billed(patientId);
    const second = await billed(patientId);
    const request = await (await prompt({ patientId, phone: "0712345678", amountCents: 50_800, invoiceId: second })).json();
    daraja();
    await drainOutbox();

    // Its paybill confirmation names the first bill, and is placed there first.
    await post("/c2b/confirmation", confirmation({ TransID: "SKFIRST001", TransAmount: "508.00", BillRefNumber: `INV-${year()}-000001` }));
    await paid("ws_CO_1", "SKFIRST001", 508);

    expect(await (await call("GET", `/mpesa/stk/${request.id}`, h.facility.id, h.cashier)).json())
      .toMatchObject({ status: "failed", resultDesc: "Paid, but placed against another bill or visit as M-Pesa SKFIRST001; check it" });
    expect(await invoice(second)).toMatchObject({ balanceCents: 50_800 });
  });

  it("are tried again when no token could be had, since nothing reached Safaricom", async () => {
    await setUp();
    daraja();
    await drainOutbox();
    vi.restoreAllMocks();
    resetDarajaTokens();
    const patientId = await h.patient();
    const request = await (await prompt({ patientId, phone: "0712345678", amountCents: 10_000 })).json();

    let tokenCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/oauth/v1/generate")) {
        tokenCalls += 1;
        return tokenCalls === 1 ? new Response("down", { status: 503 }) : Response.json({ access_token: "t", expires_in: "3599" });
      }
      return Response.json({ ResponseCode: "0", MerchantRequestID: "m-1", CheckoutRequestID: "ws_CO_retry", CustomerMessage: "Success" });
    });

    expect(await drainOutbox()).toMatchObject({ retried: 1 });
    expect((await (await call("GET", `/mpesa/stk/${request.id}`, h.facility.id, h.cashier)).json()).status).toBe("queued");
    await pool.query("UPDATE outbox SET available_at = now() WHERE status = 'pending'");
    await drainOutbox();

    expect((await (await call("GET", `/mpesa/stk/${request.id}`, h.facility.id, h.cashier)).json()).status).toBe("sent");
  });

  it("are closed as failed when no token could be had on the last try", async () => {
    await setUp();
    daraja();
    await drainOutbox();
    vi.restoreAllMocks();
    resetDarajaTokens();
    const patientId = await h.patient();
    const request = await (await prompt({ patientId, phone: "0712345678", amountCents: 10_000 })).json();
    await pool.query(`UPDATE outbox SET attempts = ${MAX_ATTEMPTS - 1} WHERE operation = 'mpesa.stk_push'`);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("down", { status: 503 }));

    expect(await drainOutbox()).toMatchObject({ done: 1, retried: 0, failed: 0 });

    // An outcome the cashier can see, rather than `queued` with nothing left to send it.
    expect(await (await call("GET", `/mpesa/stk/${request.id}`, h.facility.id, h.cashier)).json())
      .toMatchObject({ status: "failed", resultDesc: "M-Pesa could not be reached after several tries; the prompt was not sent" });
  });

  it("are reopened as sent when Safaricom's answer is recorded after another delivery closed them", async () => {
    await setUp();
    const patientId = await h.patient();
    const request = await (await prompt({ patientId, phone: "0712345678", amountCents: 10_000 })).json();
    await pool.query("UPDATE mpesa_stk_requests SET status = 'failed', result_desc = 'Sending was interrupted', completed_at = now() WHERE id = $1", [request.id]);

    await runAsFacility(h.facility.id, t => recordSent(t, h.facility.id, request.id, { request: {}, response: {}, httpStatus: 200, checkoutRequestId: "ws_CO_late", merchantRequestId: "m" }));

    expect(await (await call("GET", `/mpesa/stk/${request.id}`, h.facility.id, h.cashier)).json()).toMatchObject({ status: "sent", resultDesc: null });
  });

  it("whose callbacks cannot be stored are kept and acknowledged, never crash", async () => {
    await setUp();

    const answers = [
      await callback({ CheckoutRequestID: "ws_CO_bad1", ResultCode: "invalid", ResultDesc: "?" }),
      await callback({ CheckoutRequestID: "ws_CO_bad2", ResultCode: 0, ResultDesc: "Processed", CallbackMetadata: { Item: [null, { Name: "MpesaReceiptNumber", Value: "SKNULLS001" }] } }),
      await callback({ CheckoutRequestID: "ws_CO_bad3", ResultCode: 0, ResultDesc: "Processed", CallbackMetadata: { Item: [{ Name: "Amount", Value: -5 }, { Name: "MpesaReceiptNumber", Value: "SKNEGATIVE" }] } }),
    ];

    expect(answers.map(a => a.status)).toEqual([200, 200, 200]);
    expect(await db.select().from(mpesaTransactions)).toHaveLength(0);
    expect(await db.select().from(gatewayExchanges).where(eq(gatewayExchanges.operation, "stk_callback"))).toHaveLength(3);
  });

  it("are never sent again once sending began, even if the worker died", async () => {
    await setUp();
    const patientId = await h.patient();
    const request = await (await prompt({ patientId, phone: "0712345678", amountCents: 10_000 })).json();
    // As a worker leaves it that claimed the prompt and died before recording Safaricom's answer.
    await pool.query("UPDATE mpesa_stk_requests SET status = 'sending' WHERE id = $1", [request.id]);

    const fetch = daraja();
    await drainOutbox();

    expect(fetch.mock.calls.filter(([url]) => String(url).includes("stkpush"))).toHaveLength(0);
    expect(await (await call("GET", `/mpesa/stk/${request.id}`, h.facility.id, h.cashier)).json())
      .toMatchObject({ status: "failed", resultDesc: expect.stringContaining("Sending was interrupted") });
  });

  it("paid before the prompt is recorded are still placed against it", async () => {
    await setUp();
    const patientId = await h.patient();
    const invoiceId = await billed(patientId);
    const request = await (await prompt({ patientId, phone: "0712345678", amountCents: 50_800, invoiceId })).json();

    await paid("ws_CO_1", "SKEARLY001", 508);
    expect(await paymentOf("SKEARLY001")).toBeUndefined();
    daraja();
    await drainOutbox();

    expect(await (await call("GET", `/mpesa/stk/${request.id}`, h.facility.id, h.cashier)).json()).toMatchObject({ status: "completed", receiptNumber: "SKEARLY001" });
    expect(await invoice(invoiceId)).toMatchObject({ balanceCents: 0 });
  });

  it("paid before the prompt is recorded, and placed from the queue meanwhile, are linked to it", async () => {
    await setUp();
    const patientId = await h.patient();
    const invoiceId = await billed(patientId);
    const request = await (await prompt({ patientId, phone: "0712345678", amountCents: 50_800, invoiceId })).json();

    await paid("ws_CO_1", "SKPLACED01", 508);
    const [early] = await db.select().from(mpesaTransactions);
    expect((await call("POST", `/mpesa/transactions/${early.id}/assign`, h.facility.id, h.clerk, { patientId, invoiceId })).status).toBe(200);
    daraja();
    await drainOutbox();

    expect(await (await call("GET", `/mpesa/stk/${request.id}`, h.facility.id, h.cashier)).json()).toMatchObject({ status: "completed", receiptNumber: "SKPLACED01" });
    expect(await db.select().from(payments)).toHaveLength(1);
  });

  it("paid before the prompt is recorded, after the paybill confirmation of the same payment, are still placed against it", async () => {
    await setUp();
    const patientId = await h.patient();
    const invoiceId = await billed(patientId);
    const request = await (await prompt({ patientId, phone: "0712345678", amountCents: 50_800, invoiceId })).json();

    // The confirmation's shortened reference names no bill, and the callback finds no prompt yet.
    await post("/c2b/confirmation", confirmation({ TransID: "SKC2BEARLY", TransAmount: "508.00", BillRefNumber: `NV${year()}000001` }));
    await paid("ws_CO_1", "SKC2BEARLY", 508);
    expect(await paymentOf("SKC2BEARLY")).toBeUndefined();
    daraja();
    await drainOutbox();

    expect(await (await call("GET", `/mpesa/stk/${request.id}`, h.facility.id, h.cashier)).json()).toMatchObject({ status: "completed", receiptNumber: "SKC2BEARLY" });
    expect(await invoice(invoiceId)).toMatchObject({ balanceCents: 0 });
    expect(await db.select().from(payments)).toHaveLength(1);
  });

  it("paid before the prompt is recorded, after the paybill confirmation placed the payment, are linked to it", async () => {
    await setUp();
    const patientId = await h.patient();
    const { id: encounterId } = await (await call("POST", "/admissions", h.facility.id, h.nurse, { patientId, bedId: h.beds.general })).json();
    const request = await (await prompt({ patientId, phone: "0712345678", amountCents: 100_000, encounterId })).json();

    await post("/c2b/confirmation", confirmation({ TransID: "SKC2BPLACE", TransAmount: "1000.00", BillRefNumber: `ADM-${year()}-0001` }));
    expect(await paymentOf("SKC2BPLACE")).toMatchObject({ encounterId });
    await paid("ws_CO_1", "SKC2BPLACE", 1000);
    daraja();
    await drainOutbox();

    expect(await (await call("GET", `/mpesa/stk/${request.id}`, h.facility.id, h.cashier)).json()).toMatchObject({ status: "completed", receiptNumber: "SKC2BPLACE" });
    expect(await db.select().from(payments)).toHaveLength(1);
  });

  it("answered with a result code Postgres cannot store keep the callback and acknowledge it", async () => {
    await setUp();
    const patientId = await h.patient();
    const request = await (await prompt({ patientId, phone: "0712345678", amountCents: 10_000 })).json();
    daraja();
    await drainOutbox();

    // A whole number, but past a Postgres integer: the update would fail and take the kept callback with it.
    const answer = await callback({ CheckoutRequestID: "ws_CO_1", ResultCode: 2_147_483_648, ResultDesc: "?" });

    expect(answer.status).toBe(200);
    expect(await db.select().from(gatewayExchanges).where(eq(gatewayExchanges.operation, "stk_callback"))).toMatchObject([{ error: "Could not be read" }]);
    expect((await (await call("GET", `/mpesa/stk/${request.id}`, h.facility.id, h.cashier)).json()).status).toBe("sent");
  });

  it("whose callback carries an oversized checkout id still keep it", async () => {
    await setUp();

    // Incompressible and far past a btree index entry's limit: an index on the id itself would refuse the row.
    const answer = await callback({ CheckoutRequestID: randomBytes(8_000).toString("base64"), ResultCode: 1032, ResultDesc: "Cancelled" });

    expect(answer.status).toBe(200);
    expect(await db.select().from(gatewayExchanges).where(eq(gatewayExchanges.operation, "stk_callback"))).toHaveLength(1);
  });

  it("whose callback cannot be recorded keep it as Safaricom sent it, since Safaricom does not call again", async () => {
    await setUp();
    const patientId = await h.patient();
    await (await prompt({ patientId, phone: "0712345678", amountCents: 10_000 })).json();
    daraja();
    await drainOutbox();

    // The callback's own transaction fails; keeping it is a second, separate one.
    vi.spyOn(appDb, "transaction").mockImplementationOnce(() => Promise.reject(new Error("connection reset")));
    const answer = await paid("ws_CO_1", "SKLOSTONE1", 100);

    expect(answer.status).toBe(200);
    const kept = await db.select().from(gatewayExchanges).where(eq(gatewayExchanges.operation, "stk_callback"));
    expect(kept).toMatchObject([{ error: "Could not be recorded" }]);
    expect(await checkoutOfExchange(kept[0].id)).toBe("ws_CO_1");
  });

  it("are closed when the outbox gives up on them after Safaricom's answer could not be recorded", async () => {
    await setUp();
    daraja();
    await drainOutbox();
    const patientId = await h.patient();
    const request = await (await prompt({ patientId, phone: "0712345678", amountCents: 10_000 })).json();
    await pool.query(`UPDATE outbox SET attempts = ${MAX_ATTEMPTS - 1} WHERE operation = 'mpesa.stk_push'`);

    // Claimed (the first transaction), sent, then recording the answer (the second) fails.
    const real = appDb.transaction.bind(appDb);
    let opened = 0;
    vi.spyOn(appDb, "transaction").mockImplementation(((...args: Parameters<typeof real>) => {
      opened += 1;
      return opened === 2 ? Promise.reject(new Error("connection reset")) : real(...args);
    }) as typeof real);

    expect(await drainOutbox()).toMatchObject({ failed: 1 });

    // Never left `sending` with nothing left to move it.
    expect(await (await call("GET", `/mpesa/stk/${request.id}`, h.facility.id, h.cashier)).json())
      .toMatchObject({ status: "failed", resultDesc: expect.stringContaining("Sending was interrupted") });
  });

  it("are closed when their worker died on the last try", async () => {
    await setUp();
    const patientId = await h.patient();
    const request = await (await prompt({ patientId, phone: "0712345678", amountCents: 10_000 })).json();
    // As a worker leaves it that claimed the prompt on its last try and died; its lease has run out.
    await pool.query("UPDATE mpesa_stk_requests SET status = 'sending' WHERE id = $1", [request.id]);
    await pool.query(`UPDATE outbox SET attempts = ${MAX_ATTEMPTS}, available_at = now() - interval '1 minute' WHERE operation = 'mpesa.stk_push'`);

    const fetch = daraja();
    await drainOutbox();

    expect(fetch.mock.calls.filter(([url]) => String(url).includes("stkpush"))).toHaveLength(0);
    expect(await (await call("GET", `/mpesa/stk/${request.id}`, h.facility.id, h.cashier)).json())
      .toMatchObject({ status: "failed", resultDesc: expect.stringContaining("Sending was interrupted") });
  });

  it("paid in a different amount wait for review, and one accepted without a checkout id fails", async () => {
    await setUp();
    const patientId = await h.patient();
    const request = await (await prompt({ patientId, phone: "0712345678", amountCents: 10_000 })).json();
    daraja();
    await drainOutbox();

    await paid("ws_CO_1", "SKDIFFER01", 50);

    expect(await (await call("GET", `/mpesa/stk/${request.id}`, h.facility.id, h.cashier)).json()).toMatchObject({ status: "failed" });
    const [transaction] = await db.select().from(mpesaTransactions);
    expect(transaction).toMatchObject({ status: "unmatched", statusReason: "Paid KES 50.00 against a prompt for KES 100.00; check before placing it" });

    const blank = await (await prompt({ patientId, phone: "0712345678", amountCents: 10_000 })).json();
    vi.restoreAllMocks();
    daraja({ stk: () => Response.json({ ResponseCode: "0", CustomerMessage: "Success" }) });
    await drainOutbox();
    expect(await (await call("GET", `/mpesa/stk/${blank.id}`, h.facility.id, h.cashier)).json())
      .toMatchObject({ status: "failed", resultDesc: "STK push accepted without a checkout id" });
  });
});

describe("in the database", () => {
  it("matching a typed number uses its index, query and index sharing one expression", async () => {
    const lookups = [
      ["documents_normalised_invoice_number_index", db.select({ id: documents.id }).from(documents).where(sql`${documents.facilityId} = ${h.facility.id} AND ${documents.kind} = 'invoice' AND ${normalisedNumber(documents.number)} = ${"INV2026000001"}`)],
      ["admissions_normalised_number_index", db.select({ id: admissions.id }).from(admissions).where(sql`${admissions.facilityId} = ${h.facility.id} AND ${normalisedNumber(admissions.admissionNumber)} = ${"ADM20260001"}`)],
      ["patient_numbers_normalised_number_index", db.select({ id: patientNumbers.id }).from(patientNumbers).where(sql`${patientNumbers.facilityId} = ${h.facility.id} AND ${normalisedNumber(patientNumbers.number)} = ${"OPD1201"}`)],
      // The early-callback lookups by checkout id, likewise.
      ["mpesa_transactions_stk_checkout_index", db.select({ id: mpesaTransactions.id }).from(mpesaTransactions).where(sql`${mpesaTransactions.facilityId} = ${h.facility.id} AND ${mpesaTransactions.source} = 'stk' AND ${stkCheckoutId(mpesaTransactions.rawPayload)} = ${"ws_CO_1"}`)],
      ["gateway_exchanges_stk_checkout_index", db.select({ id: gatewayExchanges.id }).from(gatewayExchanges).where(sql`${gatewayExchanges.facilityId} = ${h.facility.id} AND ${gatewayExchanges.operation} = 'stk_callback' AND ${stkCheckoutId(gatewayExchanges.response)} = ${"ws_CO_1"}`)],
    ] as const;

    const client = await pool.connect();
    try {
      // The tables are tiny here, so a scan would win on cost; this asks whether the index can serve the query at all.
      await client.query("SET enable_seqscan = off");
      for (const [index, query] of lookups) {
        const { sql: text, params } = query.toSQL();
        const { rows } = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN ${text}`, params);
        expect(rows.map(r => r["QUERY PLAN"]).join("\n")).toContain(index);
      }
    }
    finally {
      await client.query("RESET enable_seqscan");
      client.release();
    }
  });

  it("m-Pesa transactions keep what Safaricom said, and exchanges are append-only", async () => {
    await setUp();
    await post("/c2b/confirmation", confirmation({ TransID: "SKGUARD001" }));
    const [transaction] = await db.select().from(mpesaTransactions);

    await expect(pool.query("UPDATE mpesa_transactions SET amount_cents = 100 WHERE id = $1", [transaction.id])).rejects.toMatchObject({ code: "23001" });
    await expect(pool.query("DELETE FROM mpesa_transactions WHERE id = $1", [transaction.id])).rejects.toMatchObject({ code: "23001" });
    await expect(pool.query("UPDATE mpesa_transactions SET status = 'rejected', status_reason = NULL WHERE id = $1", [transaction.id])).rejects.toMatchObject({ code: "23514" });

    daraja();
    await drainOutbox();
    await expect(pool.query("UPDATE gateway_exchanges SET error = 'x'")).rejects.toMatchObject({ code: "23001" });
    await expect(pool.query("DELETE FROM gateway_exchanges")).rejects.toMatchObject({ code: "23001" });
  });

  it("an M-Pesa payment names its transaction, and only M-Pesa may have no receiver", async () => {
    const patientId = await h.patient();
    await call("POST", "/cashier-shifts", h.facility.id, h.cashier, { openingFloatCents: 0 });
    const cash = await (await call("POST", "/payments", h.facility.id, h.cashier, { patientId, method: "cash", amountCents: 1_000 })).json();
    const copy = (method: string, receiver: string) => pool.query(
      `INSERT INTO payments (facility_id, account_id, method, amount_cents, reference, document_id, received_by)
       SELECT facility_id, account_id, $2, amount_cents, 'REF123', document_id, ${receiver} FROM payments WHERE id = $1`,
      [cash.id, method],
    );

    await expect(copy("mpesa_c2b", "received_by")).rejects.toMatchObject({ code: "23514" });
    await expect(copy("bank", "NULL")).rejects.toMatchObject({ code: "23514" });
  });
});
