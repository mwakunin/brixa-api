import { and, eq, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { Hospital, StaffMember } from "@/test/hospital";

import db from "@/db";
import { auditLog, charges } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import { addDays, businessDate } from "@/lib/dates";
import { pgErrorCode } from "@/lib/db-errors";
import { recordReturn } from "@/lib/dispense-returns";
import { loadDrugCatalogue } from "@/lib/drug-catalogue-load";
import { receiveGoods } from "@/lib/goods-received";
import { addMembership, resetDb, signedInUser } from "@/test/helpers";
import { call, hospital } from "@/test/hospital";

/** P4 slice 3b: patients' returns, and stock adjustments. */

const SAMPLE = path.resolve(import.meta.dirname, "../test/fixtures/drug-catalogue-sample.csv");

let h: Hospital;
let doctor: StaffMember;
let pharmacist: StaffMember;
let pharmTech: StaffMember;
let storekeeper: StaffMember;
let pharmacy: string;
/** KES 2.50 a tablet; 3,000 on the shelf in batch P1, expiring in 300 days. */
let paracetamol: string;
let p1: string;

const inDays = (days: number) => addDays(businessDate(), days);

async function staff(roles: Parameters<typeof addMembership>[2]): Promise<StaffMember> {
  const user = await signedInUser();
  const membership = await addMembership(user.id, h.facility.id, roles);
  return { ...user, actor: { userId: user.id, membershipId: membership.id } };
}

async function created(res: Response) {
  expect(res.status).toBe(201);
  return res.json();
}

const post = (url: string, who: StaffMember, body: unknown = {}) => call("POST", url, h.facility.id, who, body);

async function refusal(res: Response, status = 409): Promise<string> {
  expect(res.status).toBe(status);
  return (await res.json()).code;
}

beforeEach(async () => {
  await resetDb();
  await loadDrugCatalogue(await readFile(SAMPLE, "utf8"));
  h = await hospital();
  doctor = await staff(["doctor"]);
  pharmacist = await staff(["pharmacist"]);
  pharmTech = await staff(["pharm_tech"]);
  storekeeper = await staff(["storekeeper"]);
  pharmacy = (await created(await post("/stores", h.admin, { name: "Pharmacy", kind: "pharmacy" }))).id;
  paracetamol = (await created(await post("/stock-items", h.admin, { billableItemId: h.items.tablet, drugCode: "PCM-500-TAB", baseUnit: "tablet", packSize: 100 }))).id;
  const note = await created(await post("/goods-received", storekeeper, { storeId: pharmacy, supplier: "MEDS", lines: [{ stockItemId: paracetamol, batchNumber: "P1", expiresOn: inDays(300), units: 3000, totalCostCents: 300_000 }] }));
  p1 = note.items[0].batchId;
});

async function shelf(): Promise<number> {
  const items = (await (await call("GET", `/stores/${pharmacy}/stock`, h.facility.id, storekeeper)).json()).items;
  return items.find((i: { stockItemId: string }) => i.stockItemId === paracetamol)?.onHand ?? 0;
}

/** 15 tablets handed over on an open outpatient visit: charged KES 38. */
async function handedOver(): Promise<{ encounterId: string; lineId: string; patientId: string; dispenseId: string }> {
  const patientId = await h.patient();
  const visit = await created(await post("/encounters", h.nurse, { patientId, kind: "opd" }));
  const order = await created(await post(`/encounters/${visit.id}/prescriptions`, doctor, { items: [{ drugCode: "PCM-500-TAB", doseAmount: "1", frequency: "tds", durationDays: 5 }] }));
  const dispense = await created(await post("/dispenses", pharmacist, { orderId: order.id, lines: [{ orderItemId: order.items[0].id, stockItemId: paracetamol }] }));
  await post(`/dispenses/${dispense.id}/hand-over`, pharmacist);
  return { encounterId: visit.id, lineId: dispense.lines[0].id, patientId, dispenseId: dispense.id };
}

async function standing(encounterId: string) {
  return db.select({ quantity: charges.quantity, amountCents: charges.amountCents }).from(charges).where(and(eq(charges.encounterId, encounterId), isNull(charges.cancelledAt)));
}

const giveBack = (lineId: string, body: Record<string, unknown>, who: StaffMember = pharmacist) => post(`/dispense-lines/${lineId}/returns`, who, body);

describe("a patient's return", () => {
  it("fit to sell again, goes back on the shelf and replaces the unbilled charge with one for what was kept", async () => {
    const { encounterId, lineId, dispenseId } = await handedOver();
    expect(await shelf()).toBe(2985);

    const back = await created(await giveBack(lineId, { quantity: 5, reason: "Fever gone", fitForResale: true }));

    expect(back).toMatchObject({ status: "done", quantity: 5, invoiceAdjustmentId: null });
    expect(await shelf()).toBe(2990);
    // Ten kept, at the price first charged: KES 25.
    expect(await standing(encounterId)).toEqual([{ quantity: "10.000", amountCents: 2500 }]);
    // The dispense shows its one line at the charge standing now, not once per charge it has had.
    const dispense = await (await call("GET", `/dispenses/${dispenseId}`, h.facility.id, pharmacist)).json();
    expect(dispense.lines.map((l: { amountCents: number }) => l.amountCents)).toEqual([2500]);

    expect(await refusal(await giveBack(lineId, { quantity: 11, reason: "All of it", fitForResale: true }))).toBe("more_than_given");
    await created(await giveBack(lineId, { quantity: 10, reason: "All of it", fitForResale: true }));
    expect(await standing(encounterId)).toEqual([]);
    expect(await shelf()).toBe(3000);
  });

  it("once billed, asks for a credit note instead, which a second person approves", async () => {
    const { encounterId, lineId } = await handedOver();
    expect((await post(`/encounters/${encounterId}/bill-now`, h.cashier)).status).toBe(201);

    const back = await created(await giveBack(lineId, { quantity: 5, reason: "Fever gone", fitForResale: true }));

    expect(back.invoiceAdjustmentId).toEqual(expect.any(String));
    // KES 38 charged; KES 25 for the ten kept: KES 13 to credit.
    const pending = (await (await call("GET", "/adjustments?status=pending", h.facility.id, h.finance)).json()).adjustments;
    expect(pending).toEqual([expect.objectContaining({ id: back.invoiceAdjustmentId, kind: "credit_note", amountCents: 1300 })]);
    expect(await standing(encounterId)).toEqual([{ quantity: "15.000", amountCents: 3800 }]);
  });

  it("unfit to sell again, waits for a second person and puts nothing back", async () => {
    const { encounterId, lineId } = await handedOver();
    const back = await created(await giveBack(lineId, { quantity: 5, reason: "Strip opened and wet", fitForResale: false }));

    expect(back.status).toBe("pending");
    expect(await shelf()).toBe(2985);
    expect(await standing(encounterId)).toEqual([{ quantity: "15.000", amountCents: 3800 }]);
    // Counted against what may still come back.
    expect(await refusal(await giveBack(lineId, { quantity: 11, reason: "More", fitForResale: true }))).toBe("more_than_given");
    expect((await (await call("GET", "/dispense-returns?status=pending", h.facility.id, h.finance)).json()).returns).toHaveLength(1);
    const [listed] = await db.select().from(auditLog).where(eq(auditLog.action, "dispense_return.listed"));
    expect(listed).toMatchObject({ actorId: h.finance.id, detail: { status: "pending", encounters: [encounterId] } });

    expect(await refusal(await post(`/dispense-returns/${back.id}/approve`, pharmacist))).toBe("same_person");
    const approved = await (await post(`/dispense-returns/${back.id}/approve`, h.finance)).json();
    expect(approved.status).toBe("done");
    expect(await shelf()).toBe(2985);
    expect(await standing(encounterId)).toEqual([{ quantity: "10.000", amountCents: 2500 }]);
    expect(await refusal(await post(`/dispense-returns/${back.id}/reject`, h.finance))).toBe("not_pending");
  });

  it("is rejected without credit, and has nowhere to go once its batch has expired", async () => {
    const { encounterId, lineId } = await handedOver();
    const back = await created(await giveBack(lineId, { quantity: 5, reason: "Strip opened", fitForResale: false }));
    expect((await (await post(`/dispense-returns/${back.id}/reject`, h.finance)).json()).status).toBe("rejected");
    expect(await standing(encounterId)).toEqual([{ quantity: "15.000", amountCents: 3800 }]);

    // A year on, batch P1 has expired: nothing goes back on the shelf.
    const late = await runAsFacility(h.facility.id, tx => recordReturn(tx, h.facility.id, lineId, { quantity: 1, reason: "Late", fitForResale: true }, { ...pharmacist.actor, roles: ["pharmacist"], licenceProfession: "pharmacy" }, inDays(400)))
      .then(() => null, (e: unknown) => e);
    expect(late).toMatchObject({ code: "nowhere_to_return" });
  });

  it("is taken back by the pharmacy only, and a controlled drug by a pharmacist", async () => {
    const { lineId } = await handedOver();

    expect((await giveBack(lineId, { quantity: 1, reason: "Back", fitForResale: true }, h.nurse)).status).toBe(403);
    expect((await giveBack(lineId, { quantity: 1, reason: "Back", fitForResale: true }, pharmTech)).status).toBe(201);
    expect((await giveBack(randomUUID(), { quantity: 1, reason: "Back", fitForResale: true })).status).toBe(404);
  });
});

describe("a stock adjustment", () => {
  const ask = (body: Record<string, unknown>, who: StaffMember = storekeeper) => post("/stock-adjustments", who, body);

  it("writes off an expired batch only once a second person approves, at the batch's cost", async () => {
    expect(await refusal(await ask({ storeId: pharmacy, kind: "expired", reason: "Past date", lines: [{ batchId: p1, quantity: -10 }] }))).toBe("not_expired");
    const old = await runAsFacility(h.facility.id, tx => receiveGoods(tx, h.facility.id, { storeId: pharmacy, supplier: "MEDS", lines: [{ stockItemId: paracetamol, batchNumber: "OLD", expiresOn: inDays(-1), units: 40, totalCostCents: 4000 }] }, storekeeper.actor, inDays(-30)));
    const oldBatch = (await (await call("GET", `/goods-received/${old.note.id}`, h.facility.id, storekeeper)).json()).items[0].batchId;

    const asked = await created(await ask({ storeId: pharmacy, kind: "expired", reason: "Past date", lines: [{ batchId: oldBatch, quantity: -40 }] }));

    expect(asked).toMatchObject({ status: "pending", valueCents: -4000, lines: [expect.objectContaining({ batchNumber: "OLD", quantity: -40 })] });
    expect(await shelf()).toBe(3040);
    expect((await post(`/stock-adjustments/${asked.id}/approve`, storekeeper)).status).toBe(403);
    const approved = await (await post(`/stock-adjustments/${asked.id}/approve`, h.finance)).json();
    expect(approved.status).toBe("approved");
    expect(await shelf()).toBe(3000);
    expect(await refusal(await post(`/stock-adjustments/${asked.id}/approve`, h.finance))).toBe("not_pending");
  });

  it("refuses a line worth more than one adjustment records", async () => {
    const dear = await created(await post("/goods-received", storekeeper, { storeId: pharmacy, supplier: "MEDS", lines: [{ stockItemId: paracetamol, batchNumber: "DEAR", expiresOn: inDays(300), units: 1, totalCostCents: 2_000_000_000 }] }));

    const res = await ask({ storeId: pharmacy, kind: "found", reason: "Counted twice", lines: [{ batchId: dear.items[0].batchId, quantity: 2 }] });

    expect(await refusal(res)).toBe("value_too_large");
  });

  it("takes off only what the store holds, by the sign its kind moves, and puts found stock on an existing batch", async () => {
    expect(await refusal(await ask({ storeId: pharmacy, kind: "damaged", reason: "Wet", lines: [{ batchId: p1, quantity: 5 }] }))).toBe("wrong_sign");
    expect(await refusal(await ask({ storeId: pharmacy, kind: "lost", reason: "Missing", lines: [{ batchId: p1, quantity: -3001 }] }))).toBe("not_enough_stock");
    expect(await refusal(await ask({ storeId: pharmacy, kind: "found", reason: "Behind shelf", lines: [{ batchId: randomUUID(), quantity: 5 }] }))).toBe("batch_not_found");

    const found = await created(await ask({ storeId: pharmacy, kind: "found", reason: "Behind the shelf", lines: [{ batchId: p1, quantity: 20 }] }));
    await post(`/stock-adjustments/${found.id}/approve`, pharmacist);
    expect(await shelf()).toBe(3020);
  });

  it("is decided by someone other than its asker, withdrawn only by them, and rechecks stock when approved", async () => {
    const one = await created(await ask({ storeId: pharmacy, kind: "lost", reason: "Stolen", lines: [{ batchId: p1, quantity: -3000 }] }, pharmacist));
    const two = await created(await ask({ storeId: pharmacy, kind: "damaged", reason: "Flood", lines: [{ batchId: p1, quantity: -3000 }] }));

    expect(await refusal(await post(`/stock-adjustments/${one.id}/approve`, pharmacist))).toBe("same_person");
    expect(await refusal(await post(`/stock-adjustments/${one.id}/withdraw`, storekeeper))).toBe("not_requester");
    expect((await (await post(`/stock-adjustments/${one.id}/approve`, h.finance)).json()).status).toBe("approved");
    // The batch is empty now: the second cannot take the same stock again.
    expect(await refusal(await post(`/stock-adjustments/${two.id}/approve`, h.finance))).toBe("not_enough_stock");
    expect((await (await post(`/stock-adjustments/${two.id}/withdraw`, storekeeper)).json()).status).toBe("withdrawn");

    const err = await db.execute(sql`UPDATE stock_adjustments SET status = 'approved', decided_by = requested_by, decided_at = now() WHERE id = ${two.id}`).then(() => null, (e: unknown) => e);
    expect(pgErrorCode(err)).toBe("23514");
    expect((await call("GET", "/stock-adjustments?status=approved", h.facility.id, h.auditor)).status).toBe(200);
    expect((await call("GET", "/stock-adjustments", h.facility.id, h.cashier)).status).toBe(403);
  });
});
