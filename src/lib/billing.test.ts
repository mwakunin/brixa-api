import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { Hospital } from "@/test/hospital";

import db, { pool } from "@/db";
import { chargeAssignments, charges, documents, invoices, payers } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import { backendPid, resetDb, waitForBlockedBackend } from "@/test/helpers";
import { at, call, hospital, TODAY } from "@/test/hospital";

import { BillingError, draftInvoice, finaliseInvoice, invoiceDetail } from "./billing";
import { accrueBedDays } from "./charges";
import { admitPatient } from "./encounters";

/**
 * The money rules underneath the invoice API: a payer split (ROADMAP P2's
 * dummy-insurer exit check), the database's own guards, and races.
 */

let h: Hospital;
let encounterId: string;
const chargeIds: Record<"consultation" | "tablets", string> = { consultation: "", tablets: "" };

beforeEach(async () => {
  await resetDb();
  h = await hospital();
  encounterId = (await (await call("POST", "/encounters", h.facility.id, h.nurse, { patientId: await h.patient(), kind: "opd" })).json()).id;
  const post = async (item: string, quantity: string) => (await (await call("POST", `/encounters/${encounterId}/charges`, h.facility.id, h.clerk, {
    billableItemId: item,
    quantity,
    reason: "Before P3",
  })).json()).id as string;
  chargeIds.consultation = await post(h.items.consultation, "1");
  chargeIds.tablets = await post(h.items.tablet, "4");
});

const tx = <T>(fn: Parameters<typeof runAsFacility<T>>[1]) => runAsFacility(h.facility.id, fn);

async function dummyInsurer() {
  const [payer] = await db.insert(payers).values({ facilityId: h.facility.id, name: "Dummy Insurance" }).returning();
  return payer.id;
}

describe("a payer split", () => {
  it("bills an insurer and the patient for parts of the same charges", async () => {
    const payerId = await dummyInsurer();
    // KES 500 consultation: the insurer 400, the patient 100. KES 10 of tablets: the patient alone.
    const insurerInvoice = await tx(t => draftInvoice(t, h.facility.id, {
      encounterId,
      kind: "final",
      owner: { payerId },
      portions: new Map([[chargeIds.consultation, 40_000]]),
    }, h.cashier.actor));

    // Not final-billable while the patient's part is on no bill.
    await expect(tx(t => finaliseInvoice(t, h.facility.id, insurerInvoice, h.cashier.actor)))
      .rejects
      .toMatchObject({ code: "charges_unbilled" });

    const patientInvoice = await tx(t => draftInvoice(t, h.facility.id, { encounterId, kind: "final" }, h.cashier.actor));
    const insurer = await tx(t => finaliseInvoice(t, h.facility.id, insurerInvoice, h.cashier.actor));
    const patient = await tx(t => finaliseInvoice(t, h.facility.id, patientInvoice, h.cashier.actor));

    expect([insurer.invoice.totalCents, patient.invoice.totalCents]).toEqual([40_000, 11_000]);
    expect(insurer.invoice.accountId).not.toBe(patient.invoice.accountId);
    const detail = await tx(t => invoiceDetail(t, patientInvoice));
    expect(detail.lines.map(l => [l.code, l.amountCents])).toEqual([["CONS", 10_000], ["PCM-500", 1_000]]);

    const [printed] = await db.select().from(documents).where(eq(documents.id, insurer.invoice.documentId!));
    expect(printed.content.fields.slice(0, 2)).toEqual([
      { label: "Bill to", value: "Dummy Insurance" },
      { label: "Patient", value: "Test Patient" },
    ]);
  });

  it.each([
    ["more than is left of a charge", 50_100],
    ["part of a shilling", 40_050],
    ["nothing", 0],
  ])("refuses a portion of %s", async (_label, cents) => {
    const payerId = await dummyInsurer();

    await expect(tx(t => draftInvoice(t, h.facility.id, {
      encounterId,
      kind: "interim",
      owner: { payerId },
      portions: new Map([[chargeIds.consultation, cents]]),
    }, h.cashier.actor))).rejects.toMatchObject({ code: "portion_invalid" });
  });

  it("cannot attach one account's line to another account's invoice (M1)", async () => {
    const payerId = await dummyInsurer();
    const insurerInvoice = await tx(t => draftInvoice(t, h.facility.id, {
      encounterId,
      kind: "interim",
      owner: { payerId },
      portions: new Map([[chargeIds.consultation, 40_000]]),
    }, h.cashier.actor));
    const patientInvoice = await tx(t => draftInvoice(t, h.facility.id, { encounterId, kind: "interim" }, h.cashier.actor));
    const [patientAccount] = await db.select({ id: invoices.accountId }).from(invoices).where(eq(invoices.id, patientInvoice));

    await expect(pool.query(
      `INSERT INTO invoice_lines (facility_id, invoice_id, account_id, kind, code, description, quantity, unit_price_cents, amount_cents, service_date)
       VALUES ($1, $2, $3, 'itemised', 'CONS', 'x', 1, 100, 100, current_date)`,
      [h.facility.id, insurerInvoice, patientAccount.id],
    )).rejects.toMatchObject({ code: "23503" });
  });
});

describe("the database", () => {
  async function finalised() {
    const id = await tx(t => draftInvoice(t, h.facility.id, { encounterId, kind: "final" }, h.cashier.actor));
    await tx(t => finaliseInvoice(t, h.facility.id, id, h.cashier.actor));
    return id;
  }

  it("freezes a finalised invoice for every role, the owner included", async () => {
    const id = await finalised();

    await expect(pool.query("UPDATE invoices SET total_cents = 100 WHERE id = $1", [id])).rejects.toMatchObject({ code: "23001" });
    await expect(pool.query("UPDATE invoices SET status = 'draft', total_cents = NULL, document_id = NULL, finalised_at = NULL, finalised_by = NULL WHERE id = $1", [id]))
      .rejects
      .toMatchObject({ code: "23001" });
    await expect(pool.query("UPDATE invoice_lines SET amount_cents = 100 WHERE invoice_id = $1", [id])).rejects.toMatchObject({ code: "23001" });
    await expect(pool.query("DELETE FROM charge_assignments")).rejects.toMatchObject({ code: "23001" });
  });

  it("adds lines and assignments to drafts only", async () => {
    const id = await finalised();
    const [line] = (await pool.query("SELECT id, account_id FROM invoice_lines WHERE invoice_id = $1 LIMIT 1", [id])).rows;

    await expect(pool.query(
      `INSERT INTO invoice_lines (facility_id, invoice_id, account_id, kind, code, description, quantity, unit_price_cents, amount_cents, service_date)
       VALUES ($1, $2, $3, 'itemised', 'CONS', 'x', 1, 100, 100, current_date)`,
      [h.facility.id, id, line.account_id],
    )).rejects.toMatchObject({ code: "23001" });
    await expect(pool.query(
      "INSERT INTO charge_assignments (facility_id, charge_id, invoice_line_id, account_id, amount_cents, mode) VALUES ($1, $2, $3, $4, 100, 'itemised')",
      [h.facility.id, chargeIds.tablets, line.id, line.account_id],
    )).rejects.toMatchObject({ code: "23001" });
  });

  it("never assigns a charge beyond its amount (M4), whoever writes", async () => {
    const id = await tx(t => draftInvoice(t, h.facility.id, {
      encounterId,
      kind: "interim",
      portions: new Map([[chargeIds.consultation, 30_000]]),
    }, h.cashier.actor));
    const [line] = (await pool.query("SELECT id, account_id FROM invoice_lines WHERE invoice_id = $1", [id])).rows;

    const assign = (cents: number) => pool.query(
      "INSERT INTO charge_assignments (facility_id, charge_id, invoice_line_id, account_id, amount_cents, mode) VALUES ($1, $2, $3, $4, $5, 'itemised')",
      [h.facility.id, chargeIds.consultation, line.id, line.account_id, cents],
    );
    await expect(assign(20_100)).rejects.toMatchObject({ code: "23514" });
    await expect(assign(20_000)).resolves.toBeDefined();
  });

  it("refuses to bill a cancelled charge", async () => {
    await db.update(charges).set({ cancelledAt: new Date(), cancelledBy: h.clerk.actor.membershipId, cancellationReason: "Wrong" }).where(eq(charges.id, chargeIds.tablets));
    const id = await tx(t => draftInvoice(t, h.facility.id, { encounterId, kind: "interim" }, h.cashier.actor));
    const [line] = (await pool.query("SELECT id, account_id FROM invoice_lines WHERE invoice_id = $1", [id])).rows;

    await expect(pool.query(
      "INSERT INTO charge_assignments (facility_id, charge_id, invoice_line_id, account_id, amount_cents, mode) VALUES ($1, $2, $3, $4, 100, 'itemised')",
      [h.facility.id, chargeIds.tablets, line.id, line.account_id],
    )).rejects.toMatchObject({ code: "23001" });
  });
});

describe("races", () => {
  it("two drafts at once bill each charge once", async () => {
    const results = await Promise.allSettled([1, 2, 3].map(() =>
      tx(t => draftInvoice(t, h.facility.id, { encounterId, kind: "interim" }, h.cashier.actor))));

    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter(r => r.status === "rejected"))
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "nothing_to_bill" });
    const assigned = await db.select().from(chargeAssignments);
    expect(assigned.map(a => a.amountCents).sort((a, b) => a - b)).toEqual([1_000, 50_000]);
  });

  it("a draft and a cancellation at once: one of them wins", async () => {
    const [drafted, cancelled] = await Promise.allSettled([
      tx(t => draftInvoice(t, h.facility.id, { encounterId, kind: "final" }, h.cashier.actor)),
      call("POST", `/charges/${chargeIds.tablets}/cancel`, h.facility.id, h.clerk, { reason: "Posted in error" }),
    ]);

    expect(drafted.status).toBe("fulfilled");
    const status = (cancelled as PromiseFulfilledResult<Response>).value.status;
    const [tablets] = await db.select().from(charges).where(eq(charges.id, chargeIds.tablets));
    const billed = (await db.select().from(chargeAssignments).where(eq(chargeAssignments.chargeId, chargeIds.tablets))).length;
    // Either the cancel came first and the draft left the tablets out, or the draft came first and the cancel was refused.
    expect([[200, true, 0], [409, false, 1]]).toContainEqual([status, tablets.cancelledAt !== null, billed]);
  });

  it("the nightly bed-day run waits while a bill is being finalised", async () => {
    const patientId = await h.patient();
    const { encounterId: stay } = await tx(t => admitPatient(t, h.facility.id, { patientId, bedId: h.beds.general }, h.nurse.actor, at(0, 10)));
    await call("POST", `/encounters/${stay}/charges`, h.facility.id, h.clerk, { billableItemId: h.items.consultation, quantity: "1", reason: "Before P3" });
    const draftId = await tx(t => draftInvoice(t, h.facility.id, { encounterId: stay, kind: "final" }, h.cashier.actor));

    let finaliserPid = 0;
    let release!: () => void;
    const mayCommit = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const finalising = new Promise<void>((resolve) => {
      started = resolve;
    });
    const finaliser = tx(async (t) => {
      await finaliseInvoice(t, h.facility.id, draftId, h.cashier.actor);
      finaliserPid = await backendPid(t);
      started();
      await mayCommit;
    });

    await finalising;
    const accrual = tx(t => accrueBedDays(t, h.facility.id, stay, at(1, 2)));

    // Queued on the encounter's lock, so the night is charged after the bill, not under it.
    expect(await waitForBlockedBackend(finaliserPid)).toBe(true);
    release();
    await finaliser;
    expect((await accrual).created).toEqual([TODAY]);
  });

  it("finalising twice at once issues one number", async () => {
    const id = await tx(t => draftInvoice(t, h.facility.id, { encounterId, kind: "final" }, h.cashier.actor));

    const results = await Promise.allSettled([1, 2].map(() => tx(t => finaliseInvoice(t, h.facility.id, id, h.cashier.actor))));

    expect(results.map(r => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(BillingError);
    expect(await db.select().from(documents)).toHaveLength(1);
  });
});
