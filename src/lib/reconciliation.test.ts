import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { Hospital } from "@/test/hospital";

import app from "@/app";
import db, { pool } from "@/db";
import { jobFailures, mpesaSettings, mpesaTransactions, payments } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import { reconcileAll } from "@/jobs/reconciliation";
import { accrueBedDays } from "@/lib/charges";
import { darajaTimestamp } from "@/lib/daraja";
import { admitPatient, dischargePatient } from "@/lib/encounters";
import { reconcile } from "@/lib/reconciliation";
import { resetDb } from "@/test/helpers";
import { at, call, hospital, TODAY } from "@/test/hospital";

/** The Kenyan year now: read when used, since TODAY is re-read for each test. */
const year = () => TODAY.slice(0, 4);

let h: Hospital;
let token: string;

beforeEach(async () => {
  await resetDb();
  h = await hospital();
  await call("PUT", "/mpesa/settings", h.facility.id, h.admin, { shortcode: "600123", consumerKey: "consumer-key-1", consumerSecret: "consumer-secret-1", passkey: "stk-passkey-1" });
  [{ callbackToken: token }] = await db.select({ callbackToken: mpesaSettings.callbackToken }).from(mpesaSettings);
  await call("POST", "/cashier-shifts", h.facility.id, h.cashier, { openingFloatCents: 0 });
});

const tx = <T>(fn: Parameters<typeof runAsFacility<T>>[1]) => runAsFacility(h.facility.id, fn);

function paybill(transId: string, reference: string, amountCents: number, when = new Date()) {
  return app.request(`/webhooks/mpesa/${token}/c2b/confirmation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      TransID: transId,
      TransTime: darajaTimestamp(when),
      TransAmount: (amountCents / 100).toFixed(2),
      BusinessShortCode: "600123",
      BillRefNumber: reference,
      MSISDN: "254712345678",
    }),
  });
}

async function bill(encounterId: string, kind: "interim" | "final") {
  const { id } = await (await call("POST", `/encounters/${encounterId}/invoices`, h.facility.id, h.clerk, { kind })).json();
  expect((await call("POST", `/invoices/${id}/finalise`, h.facility.id, h.clerk)).status).toBe(200);
  return (await call("GET", `/invoices/${id}`, h.facility.id, h.finance)).json();
}

describe("a six-day admission (the P2 exit)", () => {
  it("reconciles: deposit, running bill, top-up, final bill and a partial refund", async () => {
    // Day 0, 10:00: admitted to a general bed (KES 2,500 a night), with a KES 10,000 cash deposit.
    const patientId = await h.patient();
    const { encounterId: stay } = await tx(t => admitPatient(t, h.facility.id, { patientId, bedId: h.beds.general }, h.nurse.actor, at(0, 10)));
    const deposit = await call("POST", "/payments", h.facility.id, h.cashier, { patientId, method: "cash", amountCents: 1_000_000, encounterId: stay });
    expect(deposit.status).toBe(201);
    // A consultation (KES 500) and ten tablets (KES 25).
    for (const [item, quantity] of [[h.items.consultation, "1"], [h.items.tablet, "10"]])
      await call("POST", `/encounters/${stay}/charges`, h.facility.id, h.clerk, { billableItemId: item, quantity, reason: "Before P3" });

    // Day 3: three nights so far, and a running bill the deposit settles.
    await tx(t => accrueBedDays(t, h.facility.id, stay, at(3, 2)));
    const running = await bill(stay, "interim");
    expect(running).toMatchObject({ totalCents: 802_500, paidCents: 802_500, balanceCents: 0 });

    // Day 4: a KES 10,000 top-up by M-Pesa paybill, naming the admission.
    await paybill("SKTOPUP001", `ADM-${year()}-0001`, 1_000_000, at(4, 12));
    const [topUp] = await db.select().from(payments).where(eq(payments.method, "mpesa_c2b"));
    expect(topUp.encounterId).toBe(stay);

    // Day 6, 09:00: discharged after three more nights; the final bill takes the rest of the deposit, then the top-up.
    await tx(t => dischargePatient(t, h.facility.id, stay, "home", h.nurse.actor, at(6, 9)));
    const final = await bill(stay, "final");
    expect(final).toMatchObject({ totalCents: 750_000, paidCents: 750_000, balanceCents: 0 });

    // KES 4,000 of the KES 4,475 left goes back, sent by hand over M-Pesa.
    const refund = await (await call("POST", `/payments/${topUp.id}/refunds`, h.facility.id, h.clerk, { amountCents: 400_000, reason: "Unused deposit" })).json();
    await call("POST", `/refunds/${refund.id}/approve`, h.facility.id, h.finance);
    expect((await call("POST", `/refunds/${refund.id}/pay`, h.facility.id, h.cashier, { method: "mpesa", reference: "SKREFUND01" })).status).toBe(200);

    const account = await (await call("GET", `/patients/${patientId}/account`, h.facility.id, h.cashier)).json();
    expect(account).toMatchObject({ creditCents: 47_500, owedCents: 0 });

    const { totals, drift } = await tx(t => reconcile(t));
    expect(drift).toEqual([]);
    expect(totals).toEqual({
      chargedCents: 1_552_500,
      invoicedCents: 1_552_500,
      adjustedCents: 0,
      receivedCents: 2_000_000,
      allocatedCents: 1_552_500,
      refundedCents: 400_000,
      creditCents: 47_500,
      owedCents: 0,
    });
    // M7: every shilling received is applied, returned or still held; every shilling charged is billed.
    expect(totals.receivedCents).toBe(totals.allocatedCents + totals.refundedCents + totals.creditCents);
    expect(totals.invoicedCents).toBe(totals.allocatedCents + totals.adjustedCents + totals.owedCents);
    expect(totals.chargedCents).toBe(totals.invoicedCents);
    expect(totals.creditCents).toBe(account.creditCents);
  });
});

describe("the daily reconciliation check", () => {
  it("records drift until it is fixed, naming only ids", async () => {
    await paybill("SKDRIFT001", "", 50_000);
    const [transaction] = await db.select().from(mpesaTransactions);
    expect(await reconcileAll()).toMatchObject({ drifted: 0, findings: 0, failed: 0 });

    // Marked placed with no payment behind it: what a bypassed guard would leave.
    await pool.query("UPDATE mpesa_transactions SET status = 'allocated', status_reason = NULL WHERE id = $1", [transaction.id]);

    expect(await reconcileAll()).toMatchObject({ drifted: 1, findings: 1 });
    expect(await reconcileAll()).toMatchObject({ drifted: 1, findings: 1 });
    const open = await db.select().from(jobFailures).where(eq(jobFailures.job, "reconciliation"));
    expect(open).toMatchObject([{ subjectId: transaction.id, error: "mpesa: 0 against 50000", resolvedAt: null }]);

    await pool.query("UPDATE mpesa_transactions SET status = 'unmatched' WHERE id = $1", [transaction.id]);
    await reconcileAll();
    const [fixed] = await db.select().from(jobFailures).where(eq(jobFailures.job, "reconciliation"));
    expect(fixed.resolvedAt).not.toBeNull();
  });

  it("finds each identity broken, as a bypassed guard would leave it", async () => {
    const patientId = await h.patient();
    const { id: encounterId } = await (await call("POST", "/encounters", h.facility.id, h.nurse, { patientId, kind: "opd" })).json();
    for (const [item, quantity] of [[h.items.consultation, "1"], [h.items.tablet, "3"]])
      await call("POST", `/encounters/${encounterId}/charges`, h.facility.id, h.clerk, { billableItemId: item, quantity, reason: "Before P3" });
    const { id: invoiceId } = await (await call("POST", `/encounters/${encounterId}/invoices`, h.facility.id, h.clerk, { kind: "final" })).json();
    await call("POST", `/invoices/${invoiceId}/finalise`, h.facility.id, h.clerk);
    const payment = await (await call("POST", "/payments", h.facility.id, h.cashier, { patientId, method: "cash", amountCents: 10_000 })).json();
    const [assignment] = (await pool.query("SELECT * FROM charge_assignments LIMIT 1")).rows;

    // Triggers off, as only a superuser can: what each check exists to catch.
    let lateCharge = "";
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `INSERT INTO refunds (facility_id, payment_id, account_id, amount_cents, reason, status, requested_by, decided_by, decided_at)
         VALUES ($1, $2, $3, 20000, 'x', 'approved', $4, $5, now())`,
        [h.facility.id, payment.id, payment.accountId, h.clerk.actor.membershipId, h.finance.actor.membershipId],
      );
      await client.query(
        `INSERT INTO invoice_adjustments (facility_id, invoice_id, account_id, kind, amount_cents, reason, status, requested_by, decided_by, decided_at)
         SELECT facility_id, id, account_id, 'waiver', 60000, 'x', 'approved', $2, $3, now() FROM invoices WHERE id = $1`,
        [invoiceId, h.clerk.actor.membershipId, h.finance.actor.membershipId],
      );
      // A charge from before the final bill that no bill carries.
      const late = await client.query(
        `INSERT INTO charges (facility_id, encounter_id, billable_item_id, quantity, unit_price_cents, amount_cents, price_list_item_id, service_date, manual_reason, captured_by, captured_at)
         SELECT facility_id, encounter_id, billable_item_id, quantity, unit_price_cents, amount_cents, price_list_item_id, service_date, manual_reason, captured_by, captured_at - interval '1 hour'
         FROM charges WHERE id = $1 RETURNING id`,
        [assignment.charge_id],
      );
      lateCharge = late.rows[0].id;
      await client.query(
        "INSERT INTO charge_assignments (facility_id, charge_id, invoice_line_id, account_id, amount_cents, mode) VALUES ($1, $2, $3, $4, $5, $6)",
        [assignment.facility_id, assignment.charge_id, assignment.invoice_line_id, assignment.account_id, assignment.amount_cents, assignment.mode],
      );
      await client.query("COMMIT");
    }
    finally {
      client.release();
    }

    const { drift } = await tx(t => reconcile(t));
    expect(drift.map(d => [d.identity, d.subjectId])).toEqual(expect.arrayContaining([
      ["M2", payment.id],
      ["M3", invoiceId],
      ["M4", assignment.charge_id],
      ["M4_final", lateCharge],
    ]));
  });

  it("is an internal job, called by Cloud Scheduler alone", async () => {
    expect((await app.request("/internal/jobs/reconciliation", { method: "POST" })).status).toBe(401);
  });
});
