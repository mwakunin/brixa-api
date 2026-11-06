import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { Hospital, Person } from "@/test/hospital";

import db, { pool } from "@/db";
import { auditLog, documents, payments } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import { approveAdjustment, requestAdjustment } from "@/lib/adjustments";
import { allocate } from "@/lib/allocations";
import { admitPatient, dischargePatient } from "@/lib/encounters";
import { recordPayment } from "@/lib/payments";
import { resetDb } from "@/test/helpers";
import { at, call, hospital, TODAY } from "@/test/hospital";

/** The Kenyan year now: read when used, since TODAY is re-read for each test. */
const year = () => TODAY.slice(0, 4);

let h: Hospital;

beforeEach(async () => {
  await resetDb();
  h = await hospital();
});

const tx = <T>(fn: Parameters<typeof runAsFacility<T>>[1]) => runAsFacility(h.facility.id, fn);

async function refusal(res: Response) {
  return [res.status, (await res.json()).code];
}

function openShift(as: Person = h.cashier, openingFloatCents = 500_000) {
  return call("POST", "/cashier-shifts", h.facility.id, as, { openingFloatCents });
}
const pay = (body: Record<string, unknown>, as: Person = h.cashier) => call("POST", "/payments", h.facility.id, as, body);
const invoice = async (id: string) => (await call("GET", `/invoices/${id}`, h.facility.id, h.finance)).json();

/** A patient's closed visit with a finalised KES 508 bill (a consultation and three tablets). */
async function billed(patientId?: string) {
  const patient = patientId ?? await h.patient();
  const encounterId = (await (await call("POST", "/encounters", h.facility.id, h.nurse, { patientId: patient, kind: "opd" })).json()).id;
  for (const [item, quantity] of [[h.items.consultation, "1"], [h.items.tablet, "3"]])
    await call("POST", `/encounters/${encounterId}/charges`, h.facility.id, h.clerk, { billableItemId: item, quantity, reason: "Before P3" });
  const invoiceId = (await (await call("POST", `/encounters/${encounterId}/invoices`, h.facility.id, h.clerk, { kind: "final" })).json()).id;
  expect((await call("POST", `/invoices/${invoiceId}/finalise`, h.facility.id, h.clerk)).status).toBe(200);
  // Closed, so the same patient can come back for another visit.
  await call("POST", `/encounters/${encounterId}/close`, h.facility.id, h.nurse);
  return { patientId: patient, encounterId, invoiceId: invoiceId as string };
}

describe("cashier shifts", () => {
  it("open once per cashier, and close with the cash counted", async () => {
    const opened = await openShift();
    expect(opened.status).toBe(201);
    const shift = await opened.json();
    expect(await refusal(await openShift())).toEqual([409, "shift_open"]);
    expect((await (await call("GET", "/cashier-shifts/current", h.facility.id, h.cashier)).json()).shift.id).toBe(shift.id);

    const { patientId } = await billed();
    await pay({ patientId, method: "cash", amountCents: 30_000 });
    await pay({ patientId, method: "card", amountCents: 20_000, reference: "AUTH 1234" });

    const close = (declaredCashCents: number, as: Person = h.cashier) =>
      call("POST", `/cashier-shifts/${shift.id}/close`, h.facility.id, as, { declaredCashCents });
    expect(await refusal(await close(0, h.finance))).toEqual([409, "not_your_shift"]);
    const closed = await close(520_000);
    expect(await closed.json()).toMatchObject({
      cashCents: 30_000,
      cardCents: 20_000,
      paymentCount: 2,
      expectedCashCents: 530_000,
      declaredCashCents: 520_000,
      varianceCents: -10_000,
    });
    expect(await refusal(await close(520_000))).toEqual([409, "shift_closed"]);
    expect((await (await call("GET", "/cashier-shifts/current", h.facility.id, h.cashier)).json()).shift).toBeNull();
  });

  it("are needed for cash and card, not for a bank transfer", async () => {
    const { patientId } = await billed();

    expect(await refusal(await pay({ patientId, method: "cash", amountCents: 1_000 }))).toEqual([409, "shift_required"]);
    expect(await refusal(await pay({ patientId, method: "card", amountCents: 1_000, reference: "AUTH 1" }))).toEqual([409, "shift_required"]);
    expect((await pay({ patientId, method: "bank", amountCents: 1_000, reference: "FT26110412345" }, h.finance)).status).toBe(201);
  });

  it("are seen by their cashier and by finance, not by another cashier", async () => {
    const shift = await (await openShift(h.finance)).json();

    expect((await call("GET", `/cashier-shifts/${shift.id}`, h.facility.id, h.cashier)).status).toBe(404);
    expect((await call("GET", `/cashier-shifts/${shift.id}`, h.facility.id, h.auditor)).status).toBe(200);
    expect((await call("GET", "/cashier-shifts", h.facility.id, h.cashier)).status).toBe(403);
  });
});

describe("payments", () => {
  beforeEach(async () => {
    await openShift();
  });

  it("settle as much of the bill as it owes, keep the rest as credit, and issue a receipt", async () => {
    const { patientId, invoiceId } = await billed();

    const res = await pay({ patientId, method: "cash", amountCents: 60_000, invoiceId });
    expect(res.status).toBe(201);
    const payment = await res.json();
    expect(payment).toMatchObject({ receiptNumber: `RCT-${year()}-000001`, amountCents: 60_000, unallocatedCents: 9_200 });
    expect(payment.allocations).toMatchObject([{ invoiceId, invoiceNumber: `INV-${year()}-000001`, amountCents: 50_800 }]);
    expect(await invoice(invoiceId)).toMatchObject({ paidCents: 50_800, balanceCents: 0 });

    const [receipt] = await db.select().from(documents).where(eq(documents.id, payment.documentId));
    expect(receipt.content).toMatchObject({
      title: "Receipt",
      fields: expect.arrayContaining([
        { label: "Received from", value: "Test Patient" },
        { label: "For", value: `Invoice INV-${year()}-000001` },
        { label: "Paid by", value: "Cash" },
      ]),
      totals: [
        { label: "Amount received", value: "KES 600.00" },
        { label: "Applied to the bill", value: "KES 508.00" },
        { label: "Still owed on the bill", value: "KES 0.00" },
      ],
    });
  });

  it("settle part of a bill", async () => {
    const { patientId, invoiceId } = await billed();

    await pay({ patientId, method: "card", amountCents: 20_000, invoiceId, reference: "AUTH 778899" });

    expect(await invoice(invoiceId)).toMatchObject({ paidCents: 20_000, balanceCents: 30_800 });
  });

  it("need a reference for card and bank, and none for cash", async () => {
    const { patientId } = await billed();

    expect((await pay({ patientId, method: "card", amountCents: 1_000 })).status).toBe(422);
    expect((await pay({ patientId, method: "bank", amountCents: 1_000 }, h.finance)).status).toBe(422);
    expect((await pay({ patientId, method: "cash", amountCents: 1_000, reference: "X123" })).status).toBe(422);
    expect((await pay({ patientId, method: "cash", amountCents: 1_050 })).status).toBe(422);
  });

  it("are not taken against another patient's bill", async () => {
    const { invoiceId } = await billed();
    const stranger = await h.patient();

    expect(await refusal(await pay({ patientId: stranger, method: "cash", amountCents: 1_000, invoiceId }))).toEqual([409, "other_patient"]);
  });

  it("taken as a deposit settle the admission's bill when it is finalised", async () => {
    const patientId = await h.patient();
    const { encounterId } = await tx(t => admitPatient(t, h.facility.id, { patientId, bedId: h.beds.general }, h.nurse.actor, at(0, 10)));
    const deposit = await (await pay({ patientId, method: "cash", amountCents: 600_000, encounterId })).json();
    const topUp = await (await pay({ patientId, method: "cash", amountCents: 1_000, encounterId })).json();
    const [receipt] = await db.select().from(documents).where(eq(documents.id, deposit.documentId));
    expect(receipt.content.fields).toContainEqual({ label: "For", value: `Deposit, admission ADM-${year()}-0001` });

    // Two nights at KES 2,500.
    await tx(t => dischargePatient(t, h.facility.id, encounterId, "home", h.nurse.actor, at(2, 9)));
    const { id: invoiceId } = await (await call("POST", `/encounters/${encounterId}/invoices`, h.facility.id, h.clerk, { kind: "final" })).json();
    await call("POST", `/invoices/${invoiceId}/finalise`, h.facility.id, h.clerk);

    expect(await invoice(invoiceId)).toMatchObject({ totalCents: 500_000, paidCents: 500_000, balanceCents: 0 });
    const account = await (await call("GET", `/patients/${patientId}/account`, h.facility.id, h.cashier)).json();
    expect(account).toMatchObject({ creditCents: 101_000, owedCents: 0 });
    // The first deposit covered the bill; the top-up was not applied, and the audit says so.
    const [applied] = await db.select().from(auditLog).where(eq(auditLog.action, "allocation.recorded"));
    expect(applied.detail).toMatchObject({ invoiceId, amountCents: 500_000, payments: [deposit.id] });
    expect(await (await call("GET", `/payments/${topUp.id}`, h.facility.id, h.finance)).json()).toMatchObject({ unallocatedCents: 1_000 });
  });

  it("taken towards a visit whose final bill is out settle that bill", async () => {
    const { patientId, encounterId, invoiceId } = await billed();

    const payment = await (await pay({ patientId, method: "cash", amountCents: 60_000, encounterId })).json();

    expect(payment).toMatchObject({ unallocatedCents: 9_200, allocations: [{ invoiceId, amountCents: 50_800 }] });
    expect(await invoice(invoiceId)).toMatchObject({ balanceCents: 0 });
    const [receipt] = await db.select().from(documents).where(eq(documents.id, payment.documentId));
    expect(receipt.content.fields).toContainEqual({ label: "For", value: `Invoice INV-${year()}-000001` });

    // Once it owes nothing, more money towards the visit stays as its credit.
    const more = await (await pay({ patientId, method: "cash", amountCents: 1_000, encounterId })).json();
    expect(more).toMatchObject({ encounterId, unallocatedCents: 1_000, allocations: [] });
  });

  it("left as credit are applied to a bill on request", async () => {
    const { patientId, invoiceId } = await billed();
    const credit = await (await pay({ patientId, method: "cash", amountCents: 30_000 })).json();

    const res = await call("POST", `/payments/${credit.id}/allocations`, h.facility.id, h.clerk, { invoiceId });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ unallocatedCents: 0 });
    expect(await invoice(invoiceId)).toMatchObject({ balanceCents: 20_800 });

    const more = await (await pay({ patientId, method: "cash", amountCents: 30_000 })).json();
    const apply = (amountCents: number) => call("POST", `/payments/${more.id}/allocations`, h.facility.id, h.clerk, { invoiceId, amountCents });
    expect(await refusal(await apply(25_000))).toEqual([409, "exceeds_invoice"]);
    expect((await apply(20_800)).status).toBe(201);
    expect(await refusal(await call("POST", `/payments/${more.id}/allocations`, h.facility.id, h.clerk, { invoiceId }))).toEqual([409, "nothing_to_allocate"]);
  });

  it("are reversed by finance, never by whoever took them, voiding the receipt and reopening the bill", async () => {
    const { patientId, invoiceId } = await billed();
    const payment = await (await pay({ patientId, method: "cash", amountCents: 50_800, invoiceId })).json();
    const reverse = (as: Person) => call("POST", `/payments/${payment.id}/reverse`, h.facility.id, as, { reason: "Wrong patient" });

    expect((await reverse(h.cashier)).status).toBe(403);
    const reversed = await reverse(h.finance);
    expect(reversed.status).toBe(200);
    expect(await reversed.json()).toMatchObject({ reversalReason: "Wrong patient", unallocatedCents: 0 });
    expect(await refusal(await reverse(h.admin))).toEqual([409, "already_reversed"]);

    expect(await invoice(invoiceId)).toMatchObject({ paidCents: 0, balanceCents: 50_800 });
    const [receipt] = await db.select().from(documents).where(eq(documents.id, payment.documentId));
    expect(receipt.voidReason).toBe("Wrong patient");
    const shift = (await (await call("GET", "/cashier-shifts/current", h.facility.id, h.cashier)).json()).shift;
    expect(shift).toMatchObject({ cashCents: 0, paymentCount: 0 });

    const own = await (await pay({ patientId, method: "bank", amountCents: 1_000, reference: "FT1234" }, h.finance)).json();
    expect(await refusal(await call("POST", `/payments/${own.id}/reverse`, h.facility.id, h.finance, { reason: "Typo" }))).toEqual([409, "same_person"]);
  });

  it("keep a paid bill from being voided until the allocation is reversed", async () => {
    const { patientId, invoiceId } = await billed();
    const payment = await (await pay({ patientId, method: "cash", amountCents: 10_000, invoiceId })).json();
    const voidIt = () => call("POST", `/invoices/${invoiceId}/void`, h.facility.id, h.finance, { reason: "Wrong patient" });

    expect(await refusal(await voidIt())).toEqual([409, "has_payments"]);
    const reversed = await call("POST", `/allocations/${payment.allocations[0].id}/reverse`, h.facility.id, h.finance, { reason: "Wrong bill" });
    expect(await reversed.json()).toMatchObject({ unallocatedCents: 10_000 });
    expect((await voidIt()).status).toBe(200);
  });

  it("share the bill with adjustments, never together exceeding it", async () => {
    const { patientId, invoiceId } = await billed();
    await pay({ patientId, method: "cash", amountCents: 50_000, invoiceId });

    const asked = await call("POST", `/invoices/${invoiceId}/adjustments`, h.facility.id, h.cashier, { kind: "waiver", amountCents: 1_000, reason: "Charity" });
    expect(await refusal(asked)).toEqual([409, "exceeds_balance"]);
  });

  it("show on the patient's account, which is audited and kept to those who handle money", async () => {
    const { patientId, invoiceId } = await billed();
    await pay({ patientId, method: "cash", amountCents: 10_000 });
    await billed(patientId);

    const res = await call("GET", `/patients/${patientId}/account`, h.facility.id, h.cashier);
    const account = await res.json();
    expect(account).toMatchObject({ creditCents: 10_000, owedCents: 101_600 });
    expect(account.invoices.map((i: { id: string }) => i.id)).toContain(invoiceId);
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "account.viewed"));
    expect(entry).toMatchObject({ actorId: h.cashier.id, entityId: patientId });
    expect((await call("GET", `/patients/${patientId}/account`, h.facility.id, h.nurse)).status).toBe(403);
  });

  it("are not found from another facility", async () => {
    const { patientId } = await billed();
    const payment = await (await pay({ patientId, method: "cash", amountCents: 1_000 })).json();
    const elsewhere = await hospital();

    expect((await call("GET", `/payments/${payment.id}`, elsewhere.facility.id, elsewhere.cashier)).status).toBe(404);
    expect((await call("GET", `/payments/${payment.id}`, h.facility.id, h.auditor)).status).toBe(200);
    const [look] = await db.select().from(auditLog).where(eq(auditLog.action, "payment.viewed"));
    expect(look).toMatchObject({ actorId: h.auditor.id, entityId: payment.id });
    expect((await call("POST", `/payments/${payment.id}/reverse`, elsewhere.facility.id, elsewhere.finance, { reason: "Test" })).status).toBe(404);
  });
});

describe("in the database", () => {
  beforeEach(async () => {
    await openShift();
  });

  it("payments and allocations change only by reversal, whoever writes", async () => {
    const { patientId, invoiceId } = await billed();
    const payment = await (await pay({ patientId, method: "cash", amountCents: 10_000, invoiceId })).json();

    await expect(pool.query("UPDATE payments SET amount_cents = 100 WHERE id = $1", [payment.id])).rejects.toMatchObject({ code: "23001" });
    await expect(pool.query("UPDATE allocations SET amount_cents = 100 WHERE payment_id = $1", [payment.id])).rejects.toMatchObject({ code: "23001" });
    await expect(pool.query("DELETE FROM allocations WHERE payment_id = $1", [payment.id])).rejects.toMatchObject({ code: "23001" });
    await expect(pool.query("DELETE FROM payments WHERE id = $1", [payment.id])).rejects.toMatchObject({ code: "23001" });
    // Reversed only with a reason, and never by the person who took it.
    await expect(pool.query("UPDATE payments SET reversed_at = now(), reversed_by = $2 WHERE id = $1", [payment.id, h.finance.actor.membershipId]))
      .rejects
      .toMatchObject({ code: "23514" });
    await expect(pool.query("UPDATE payments SET reversed_at = now(), reversed_by = received_by, reversal_reason = 'x' WHERE id = $1", [payment.id]))
      .rejects
      .toMatchObject({ code: "23514" });
  });

  it("an allocation never exceeds its payment (M2) or its bill (M3)", async () => {
    const { patientId, invoiceId } = await billed();
    const payment = await (await pay({ patientId, method: "cash", amountCents: 60_000 })).json();
    const [row] = await db.select().from(payments).where(eq(payments.id, payment.id));
    const insert = (cents: number) => pool.query(
      "INSERT INTO allocations (facility_id, payment_id, invoice_id, account_id, amount_cents, allocated_by) VALUES ($1, $2, $3, $4, $5, $6)",
      [h.facility.id, payment.id, invoiceId, row.accountId, cents, row.receivedBy],
    );

    await expect(insert(50_900)).rejects.toMatchObject({ code: "23514" });
    await expect(insert(50_800)).resolves.toBeDefined();
    const { invoiceId: other } = await billed(patientId);
    await expect(pool.query(
      "INSERT INTO allocations (facility_id, payment_id, invoice_id, account_id, amount_cents, allocated_by) VALUES ($1, $2, $3, $4, 10000, $5)",
      [h.facility.id, payment.id, other, row.accountId, row.receivedBy],
    )).rejects.toMatchObject({ code: "23514" });
  });

  it("a closed shift never changes", async () => {
    const shift = (await (await call("GET", "/cashier-shifts/current", h.facility.id, h.cashier)).json()).shift;
    // Closed only with the cash counted.
    await expect(pool.query("UPDATE cashier_shifts SET closed_at = now() WHERE id = $1", [shift.id])).rejects.toMatchObject({ code: "23514" });
    await call("POST", `/cashier-shifts/${shift.id}/close`, h.facility.id, h.cashier, { declaredCashCents: 500_000 });

    await expect(pool.query("UPDATE cashier_shifts SET declared_cash_cents = 0 WHERE id = $1", [shift.id])).rejects.toMatchObject({ code: "23001" });
  });
});

describe("races", () => {
  beforeEach(async () => {
    await openShift();
  });

  it("one payment applied to two bills at once is never spent twice", async () => {
    const { patientId, invoiceId: first } = await billed();
    const { invoiceId: second } = await billed(patientId);
    const paymentId = await tx(t => recordPayment(t, h.facility.id, { patientId, method: "cash", amountCents: 50_000 }, h.cashier.actor));

    const results = await Promise.allSettled([first, second].map(invoiceId =>
      tx(t => allocate(t, h.facility.id, { paymentId, invoiceId, amountCents: 40_000 }, h.clerk.actor))));

    expect(results.map(r => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "exceeds_payment" });
  });

  it("a payment and an adjustment at once never take off more than the bill", async () => {
    const { patientId, invoiceId } = await billed();
    const adjustmentId = await tx(t => requestAdjustment(t, h.facility.id, { invoiceId, kind: "waiver", amountCents: 30_000, reason: "Charity" }, h.cashier.actor));
    const paymentId = await tx(t => recordPayment(t, h.facility.id, { patientId, method: "cash", amountCents: 30_000 }, h.cashier.actor));

    const results = await Promise.allSettled([
      tx(t => approveAdjustment(t, h.facility.id, adjustmentId, h.finance.actor)),
      tx(t => allocate(t, h.facility.id, { paymentId, invoiceId, amountCents: 30_000 }, h.clerk.actor)),
    ]);

    expect(results.map(r => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(["exceeds_balance", "exceeds_invoice"]).toContain((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason.code);
  });
});
