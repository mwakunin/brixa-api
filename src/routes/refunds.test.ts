import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { Hospital, Person } from "@/test/hospital";

import db, { pool } from "@/db";
import { auditLog, documents, refunds } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import { allocate } from "@/lib/allocations";
import { recordPayment } from "@/lib/payments";
import { approveRefund, requestRefund } from "@/lib/refunds";
import { resetDb } from "@/test/helpers";
import { call, hospital, TODAY } from "@/test/hospital";

const YEAR = TODAY.slice(0, 4);

let h: Hospital;

beforeEach(async () => {
  await resetDb();
  h = await hospital();
  // The cashier's drawer: a KES 5,000 float.
  await call("POST", "/cashier-shifts", h.facility.id, h.cashier, { openingFloatCents: 500_000 });
});

const tx = <T>(fn: Parameters<typeof runAsFacility<T>>[1]) => runAsFacility(h.facility.id, fn);

async function refusal(res: Response) {
  return [res.status, (await res.json()).code];
}

const pay = (body: Record<string, unknown>, as: Person = h.cashier) => call("POST", "/payments", h.facility.id, as, body);
const payment = async (id: string) => (await call("GET", `/payments/${id}`, h.facility.id, h.finance)).json();
const shift = async () => (await (await call("GET", "/cashier-shifts/current", h.facility.id, h.cashier)).json()).shift;

function ask(paymentId: string, body: Record<string, unknown> = {}, as: Person = h.clerk) {
  return call("POST", `/payments/${paymentId}/refunds`, h.facility.id, as, { reason: "Cover came through", ...body });
}
function decide(id: string, action: "approve" | "reject" | "withdraw", as: Person = h.finance) {
  return call("POST", `/refunds/${id}/${action}`, h.facility.id, as);
}
function payOut(id: string, body: Record<string, unknown> = { method: "cash" }, as: Person = h.cashier) {
  return call("POST", `/refunds/${id}/pay`, h.facility.id, as, body);
}
function reverse(id: string, as: Person = h.finance) {
  return call("POST", `/refunds/${id}/reverse`, h.facility.id, as, { reason: "Recorded in error" });
}

/** A KES 600 cash deposit on a new patient's account, nothing yet owed. */
async function deposit(amountCents = 60_000) {
  const patientId = await h.patient();
  return (await (await pay({ patientId, method: "cash", amountCents })).json()) as { id: string; documentId: string };
}

/** A refund of the whole deposit, asked for and approved. */
async function approved(paymentId: string) {
  const refund = await (await ask(paymentId)).json();
  expect((await decide(refund.id, "approve")).status).toBe(200);
  return refund.id as string;
}

/** A patient's closed visit with a finalised KES 508 bill. */
async function billed(patientId: string) {
  const encounterId = (await (await call("POST", "/encounters", h.facility.id, h.nurse, { patientId, kind: "opd" })).json()).id;
  for (const [item, quantity] of [[h.items.consultation, "1"], [h.items.tablet, "3"]])
    await call("POST", `/encounters/${encounterId}/charges`, h.facility.id, h.clerk, { billableItemId: item, quantity, reason: "Before P3" });
  const invoiceId = (await (await call("POST", `/encounters/${encounterId}/invoices`, h.facility.id, h.clerk, { kind: "final" })).json()).id;
  expect((await call("POST", `/invoices/${invoiceId}/finalise`, h.facility.id, h.clerk)).status).toBe(200);
  await call("POST", `/encounters/${encounterId}/close`, h.facility.id, h.nurse);
  return invoiceId as string;
}

describe("refunds", () => {
  it("are asked for, approved by finance, paid out from the drawer, and numbered then", async () => {
    const credit = await deposit();

    const asked = await ask(credit.id);
    expect(asked.status).toBe(201);
    const refund = await asked.json();
    expect(refund).toMatchObject({ amountCents: 60_000, status: "pending", number: null, receiptNumber: `RCT-${YEAR}-000001` });
    expect((await decide(refund.id, "approve", h.clerk)).status).toBe(403);
    expect(await (await decide(refund.id, "approve")).json()).toMatchObject({ status: "approved", decidedBy: h.finance.actor.membershipId });
    expect(await payment(credit.id)).toMatchObject({ unallocatedCents: 0, refunds: [{ id: refund.id, status: "approved", number: null }] });

    const paid = await payOut(refund.id);
    expect(paid.status).toBe(200);
    const done = await paid.json();
    expect(done).toMatchObject({ number: `RFD-${YEAR}-000001`, method: "cash", reference: null, paidBy: h.cashier.actor.membershipId });
    expect(done.documentId).toEqual(expect.any(String));
    expect(await refusal(await payOut(refund.id))).toEqual([409, "already_paid"]);

    expect(await shift()).toMatchObject({ cashCents: 60_000, cashRefundsCents: 60_000, refundCount: 1, expectedCashCents: 500_000 });
    const [row] = await db.select().from(refunds).where(eq(refunds.id, refund.id));
    expect(row.documentId).toBe(done.documentId);
    const [printed] = await db.select().from(documents).where(eq(documents.id, row.documentId!));
    expect(printed).toMatchObject({ kind: "refund", number: `RFD-${YEAR}-000001` });
    expect(printed.content).toMatchObject({
      title: "Refund",
      fields: expect.arrayContaining([
        { label: "Paid to", value: "Test Patient" },
        { label: "Refund of", value: `Receipt RCT-${YEAR}-000001` },
        { label: "Reason", value: "Cover came through" },
        { label: "Paid by", value: "Cash" },
      ]),
      totals: [{ label: "Amount refunded", value: "KES 600.00" }],
    });
  });

  it("are decided by someone other than the asker, and withdrawn only by the asker", async () => {
    const credit = await deposit();

    const own = await (await ask(credit.id, { amountCents: 10_000 }, h.finance)).json();
    expect(await refusal(await decide(own.id, "approve"))).toEqual([409, "same_person"]);
    expect(await refusal(await decide(own.id, "reject"))).toEqual([409, "same_person"]);
    expect((await decide(own.id, "approve", h.admin)).status).toBe(200);

    const second = await (await ask(credit.id, { amountCents: 10_000 })).json();
    expect(await refusal(await decide(second.id, "withdraw", h.cashier))).toEqual([409, "not_requester"]);
    expect(await (await decide(second.id, "withdraw", h.clerk)).json()).toMatchObject({ status: "withdrawn" });
    expect(await refusal(await decide(second.id, "approve"))).toEqual([409, "not_pending"]);

    const third = await (await ask(credit.id, { amountCents: 10_000 })).json();
    expect(await (await decide(third.id, "reject")).json()).toMatchObject({ status: "rejected" });
    expect(await refusal(await payOut(third.id))).toEqual([409, "not_approved"]);

    expect((await ask(credit.id, {}, h.nurse)).status).toBe(403);
    expect(await payment(credit.id)).toMatchObject({ unallocatedCents: 50_000 });
  });

  it("never return more than the payment has left, and hold it once approved", async () => {
    const patientId = await h.patient();
    const invoiceId = await billed(patientId);
    // KES 600 against a KES 508 bill: KES 92 left as credit.
    const overpaid = await (await pay({ patientId, method: "cash", amountCents: 60_000, invoiceId })).json();

    expect(await refusal(await ask(overpaid.id, { amountCents: 10_000 }))).toEqual([409, "exceeds_payment"]);
    const first = await (await ask(overpaid.id)).json();
    const second = await (await ask(overpaid.id)).json();
    expect([first.amountCents, second.amountCents]).toEqual([9_200, 9_200]);

    expect((await decide(first.id, "approve")).status).toBe(200);
    expect(await refusal(await decide(second.id, "approve"))).toEqual([409, "exceeds_payment"]);
    expect(await refusal(await ask(overpaid.id))).toEqual([409, "nothing_to_refund"]);

    // The approved refund's credit is not applied to the next bill.
    const next = await billed(patientId);
    expect(await refusal(await call("POST", `/payments/${overpaid.id}/allocations`, h.facility.id, h.clerk, { invoiceId: next })))
      .toEqual([409, "nothing_to_allocate"]);
  });

  it("are paid out in cash or card from the payer's shift, and by bank or M-Pesa with a reference", async () => {
    const credit = await deposit();
    const cash = await (await ask(credit.id, { amountCents: 20_000 })).json();
    const mpesa = await (await ask(credit.id, { amountCents: 20_000 })).json();
    const card = await (await ask(credit.id, { amountCents: 20_000 })).json();
    await decide(cash.id, "approve");
    await decide(mpesa.id, "approve");
    await decide(card.id, "approve");

    expect(await refusal(await payOut(cash.id, { method: "cash" }, h.finance))).toEqual([409, "shift_required"]);
    expect((await payOut(mpesa.id, { method: "mpesa" }, h.finance)).status).toBe(422);
    expect((await payOut(cash.id, { method: "cash", reference: "X123" })).status).toBe(422);

    const sent = await (await payOut(mpesa.id, { method: "mpesa", reference: "SKL4H7XQ2P" }, h.finance)).json();
    expect(sent).toMatchObject({ method: "mpesa", reference: "SKL4H7XQ2P", number: `RFD-${YEAR}-000001` });

    expect(await refusal(await payOut(card.id, { method: "card", reference: "AUTH 4455" }, h.finance))).toEqual([409, "shift_required"]);
    expect((await payOut(card.id, { method: "card" })).status).toBe(422);
    const swiped = await (await payOut(card.id, { method: "card", reference: "AUTH 4455" })).json();
    expect(swiped).toMatchObject({ method: "card", reference: "AUTH 4455", number: `RFD-${YEAR}-000002` });
    const [row] = await db.select().from(refunds).where(eq(refunds.id, card.id));
    expect(row.cashierShiftId).toBe((await shift()).id);
    expect(await shift()).toMatchObject({ cashRefundsCents: 0, cardRefundsCents: 20_000, refundCount: 1, expectedCashCents: 560_000 });
  });

  it("are reversed by finance, never by whoever paid them out, returning the credit and the cash", async () => {
    const credit = await deposit();
    const refundId = await approved(credit.id);
    await payOut(refundId, { method: "bank", reference: "FT26110612345" }, h.finance);

    expect(await refusal(await reverse(refundId))).toEqual([409, "paid_by_you"]);
    expect((await reverse(refundId, h.cashier)).status).toBe(403);
    expect(await (await reverse(refundId, h.admin)).json()).toMatchObject({ reversalReason: "Recorded in error" });
    expect(await refusal(await reverse(refundId, h.admin))).toEqual([409, "already_reversed"]);

    const [row] = await db.select().from(refunds).where(eq(refunds.id, refundId));
    const [printed] = await db.select().from(documents).where(eq(documents.id, row.documentId!));
    expect(printed.voidReason).toBe("Recorded in error");
    expect(await payment(credit.id)).toMatchObject({ unallocatedCents: 60_000 });

    const again = await approved(credit.id);
    await payOut(again);
    expect(await shift()).toMatchObject({ cashRefundsCents: 60_000, expectedCashCents: 500_000 });
    await reverse(again);
    expect(await shift()).toMatchObject({ cashRefundsCents: 0, refundCount: 0, expectedCashCents: 560_000 });
  });

  it("approved but not paid out are cancelled by reversal", async () => {
    const credit = await deposit();
    const refundId = await approved(credit.id);

    expect(await (await reverse(refundId)).json()).toMatchObject({ number: null, reversalReason: "Recorded in error" });
    expect(await refusal(await payOut(refundId))).toEqual([409, "already_reversed"]);
    expect(await payment(credit.id)).toMatchObject({ unallocatedCents: 60_000 });
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "refund.reversed"));
    expect(entry.summary).toMatch(/^Cancelled an approved refund/);
  });

  it("keep their payment from being reversed while one stands", async () => {
    const credit = await deposit();
    const refund = await (await ask(credit.id, { amountCents: 30_000 })).json();
    await decide(refund.id, "approve");
    const refundId = refund.id as string;
    // A request holds nothing, so it does not stand in the way.
    const pending = await (await ask(credit.id, { amountCents: 10_000 })).json();
    const reversePayment = () => call("POST", `/payments/${credit.id}/reverse`, h.facility.id, h.finance, { reason: "Wrong patient" });

    expect(await refusal(await reversePayment())).toEqual([409, "has_refunds"]);
    await reverse(refundId);
    expect((await reversePayment()).status).toBe(200);
    expect(await refusal(await decide(pending.id, "approve"))).toEqual([409, "payment_reversed"]);
  });

  it("are listed to those who handle money, audited, and not found from elsewhere", async () => {
    const credit = await deposit();
    const refund = await (await ask(credit.id)).json();

    const listed = await (await call("GET", "/refunds?status=pending", h.facility.id, h.finance)).json();
    expect(listed.refunds.map((r: { id: string }) => r.id)).toEqual([refund.id]);
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "refund.listed"));
    expect(entry).toMatchObject({ actorId: h.finance.id, detail: { status: "pending", ids: [refund.id] } });
    expect((await call("GET", "/refunds", h.facility.id, h.nurse)).status).toBe(403);

    const toPay = async () => (await (await call("GET", "/refunds?toPay=true", h.facility.id, h.cashier)).json()).refunds.map((r: { id: string }) => r.id);
    expect(await toPay()).toEqual([]);
    await decide(refund.id, "approve");
    expect(await toPay()).toEqual([refund.id]);
    await payOut(refund.id);
    expect(await toPay()).toEqual([]);

    const elsewhere = await hospital();
    expect((await call("POST", `/refunds/${refund.id}/approve`, elsewhere.facility.id, elsewhere.finance)).status).toBe(404);
    expect((await call("POST", `/payments/${credit.id}/refunds`, elsewhere.facility.id, elsewhere.clerk, { reason: "Test" })).status).toBe(404);
  });
});

describe("in the database", () => {
  it("refunds change only along their lifecycle, whoever writes", async () => {
    const credit = await deposit();
    const refund = await (await ask(credit.id, { amountCents: 10_000 })).json();
    const [row] = await db.select().from(refunds).where(eq(refunds.id, refund.id));

    await expect(pool.query(
      `INSERT INTO refunds (facility_id, payment_id, account_id, amount_cents, reason, status, requested_by, decided_by, decided_at)
       VALUES ($1, $2, $3, 100, 'x', 'approved', $4, $5, now())`,
      [h.facility.id, credit.id, row.accountId, row.requestedBy, h.finance.actor.membershipId],
    )).rejects.toMatchObject({ code: "23001" });
    await expect(pool.query("UPDATE refunds SET amount_cents = 100 WHERE id = $1", [refund.id])).rejects.toMatchObject({ code: "23001" });
    await expect(pool.query("DELETE FROM refunds WHERE id = $1", [refund.id])).rejects.toMatchObject({ code: "23001" });
    // Never approved by the asker.
    await expect(pool.query("UPDATE refunds SET status = 'approved', decided_by = requested_by, decided_at = now() WHERE id = $1", [refund.id]))
      .rejects
      .toMatchObject({ code: "23514" });
    await expect(pool.query("UPDATE refunds SET status = 'withdrawn', decided_at = now() WHERE id = $1", [refund.id]))
      .rejects
      .toMatchObject({ code: "23514" });

    await decide(refund.id, "approve");
    await expect(pool.query(
      "UPDATE refunds SET paid_at = now(), paid_by = $2, document_id = (SELECT document_id FROM payments WHERE id = refunds.payment_id) WHERE id = $1",
      [refund.id, h.finance.actor.membershipId],
    )).rejects.toMatchObject({ code: "23514" });
    await payOut(refund.id);
    await expect(pool.query("UPDATE refunds SET status = 'rejected' WHERE id = $1", [refund.id])).rejects.toMatchObject({ code: "23001" });
    await expect(pool.query("UPDATE refunds SET paid_at = now() WHERE id = $1", [refund.id])).rejects.toMatchObject({ code: "23001" });
    // Never reversed by whoever paid it out, nor without a reason.
    await expect(pool.query("UPDATE refunds SET reversed_at = now(), reversed_by = paid_by, reversal_reason = 'x' WHERE id = $1", [refund.id]))
      .rejects
      .toMatchObject({ code: "23514" });
    await expect(pool.query("UPDATE refunds SET reversed_at = now(), reversed_by = $2 WHERE id = $1", [refund.id, h.finance.actor.membershipId]))
      .rejects
      .toMatchObject({ code: "23514" });
  });

  it("allocations and approved refunds never exceed their payment (M2), from either side", async () => {
    const patientId = await h.patient();
    const invoiceId = await billed(patientId);
    const credit = await (await pay({ patientId, method: "cash", amountCents: 60_000 })).json();
    const refund = await (await ask(credit.id, { amountCents: 20_000 })).json();
    await decide(refund.id, "approve");
    const [row] = await db.select().from(refunds).where(eq(refunds.id, refund.id));

    // KES 200 refunded and KES 508 applied would be KES 708 of KES 600.
    await expect(pool.query(
      "INSERT INTO allocations (facility_id, payment_id, invoice_id, account_id, amount_cents, allocated_by) VALUES ($1, $2, $3, $4, 50800, $5)",
      [h.facility.id, credit.id, invoiceId, row.accountId, h.clerk.actor.membershipId],
    )).rejects.toMatchObject({ code: "23514" });

    await call("POST", `/payments/${credit.id}/allocations`, h.facility.id, h.clerk, { invoiceId, amountCents: 40_000 });
    const late = await tx(t => requestRefund(t, h.facility.id, { paymentId: credit.id, amountCents: 100, reason: "Rounding" }, h.clerk.actor)).catch(e => e);
    expect(late).toMatchObject({ code: "exceeds_payment" });
    await expect(pool.query(
      "INSERT INTO refunds (facility_id, payment_id, account_id, amount_cents, reason, requested_by) VALUES ($1, $2, $3, 100, 'x', $4) RETURNING id",
      [h.facility.id, credit.id, row.accountId, h.clerk.actor.membershipId],
    ).then(r => pool.query(
      "UPDATE refunds SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1",
      [r.rows[0].id, h.finance.actor.membershipId],
    ))).rejects.toMatchObject({ code: "23514" });
  });

  it("a payment with a refund standing is not reversed, and a card or bank payment needs a reference", async () => {
    const credit = await deposit();
    await approved(credit.id);

    await expect(pool.query("UPDATE payments SET reversed_at = now(), reversed_by = $2, reversal_reason = 'x' WHERE id = $1", [credit.id, h.finance.actor.membershipId]))
      .rejects
      .toMatchObject({ code: "23001" });
    await expect(pool.query(
      `INSERT INTO payments (facility_id, account_id, method, amount_cents, reference, document_id, received_by)
       SELECT facility_id, account_id, 'bank', 100, NULL, document_id, received_by FROM payments WHERE id = $1`,
      [credit.id],
    )).rejects.toMatchObject({ code: "23514" });
  });
});

describe("a closed shift", () => {
  it("takes no payment and pays out no refund, whoever writes", async () => {
    const credit = await deposit();
    const refundId = await approved(credit.id);
    const closed = await shift();
    await call("POST", `/cashier-shifts/${closed.id}/close`, h.facility.id, h.cashier, { declaredCashCents: 560_000 });

    await expect(pool.query(
      `INSERT INTO payments (facility_id, account_id, method, amount_cents, cashier_shift_id, document_id, received_by)
       SELECT facility_id, account_id, 'cash', 100, cashier_shift_id, document_id, received_by FROM payments WHERE id = $1`,
      [credit.id],
    )).rejects.toMatchObject({ code: "23001" });
    await expect(pool.query(
      `UPDATE refunds SET paid_at = now(), paid_by = $2, method = 'cash', cashier_shift_id = $3,
         document_id = (SELECT document_id FROM payments WHERE id = refunds.payment_id) WHERE id = $1`,
      [refundId, h.cashier.actor.membershipId, closed.id],
    )).rejects.toMatchObject({ code: "23001" });
  });
});

describe("races", () => {
  it("a refund approved while its payment is applied to a bill never spends it twice", async () => {
    const patientId = await h.patient();
    const invoiceId = await billed(patientId);
    const paymentId = await tx(t => recordPayment(t, h.facility.id, { patientId, method: "cash", amountCents: 60_000 }, h.cashier.actor));
    const refundId = await tx(t => requestRefund(t, h.facility.id, { paymentId, amountCents: 30_000, reason: "Cover came through" }, h.clerk.actor));

    const results = await Promise.allSettled([
      tx(t => approveRefund(t, h.facility.id, refundId, h.finance.actor)),
      tx(t => allocate(t, h.facility.id, { paymentId, invoiceId, amountCents: 50_800 }, h.clerk.actor)),
    ]);

    expect(results.map(r => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "exceeds_payment" });
  });
});
