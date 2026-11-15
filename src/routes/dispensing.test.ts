import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { Hospital, StaffMember } from "@/test/hospital";

import db from "@/db";
import { auditLog, charges, orderItems } from "@/db/schema";
import { addDays, businessDate } from "@/lib/dates";
import { loadDrugCatalogue } from "@/lib/drug-catalogue-load";
import { addMembership, resetDb, signedInUser } from "@/test/helpers";
import { call, hospital, TODAY } from "@/test/hospital";

/** P4 slice 3a: dispensing. */

const SAMPLE = path.resolve(import.meta.dirname, "../test/fixtures/drug-catalogue-sample.csv");

let h: Hospital;
let doctor: StaffMember;
let pharmacist: StaffMember;
let pharmTech: StaffMember;
let storekeeper: StaffMember;
let pharmacy: string;
/** KES 2.50 a tablet, 3,000 on the shelf. */
let paracetamol: string;

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

/** A stock item for a catalogue drug, priced per base unit and on the pharmacy's shelf. */
async function stocked(code: string, drugCode: string, baseUnit: string, unitPriceCents: number | null, units: number): Promise<string> {
  const item = (await created(await post("/billable-items", h.admin, { code, name: code, category: "drug" }))).id;
  if (unitPriceCents !== null) {
    const change = await (await post("/price-changes", h.admin, { effectiveFrom: TODAY, reason: "Tariff", lines: [{ billableItemId: item, unitPriceCents }] })).json();
    await post(`/price-changes/${change.id}/approve`, h.finance);
  }
  const stockItem = (await created(await post("/stock-items", h.admin, { billableItemId: item, drugCode, baseUnit, packSize: 1 }))).id;
  await created(await post("/goods-received", storekeeper, { storeId: pharmacy, supplier: "MEDS", lines: [{ stockItemId: stockItem, batchNumber: `B-${code}`, expiresOn: addDays(businessDate(), 300), units, totalCostCents: units * 100 }] }));
  return stockItem;
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
  await created(await post("/goods-received", storekeeper, { storeId: pharmacy, supplier: "MEDS", lines: [{ stockItemId: paracetamol, batchNumber: "P1", expiresOn: addDays(businessDate(), 300), units: 3000, totalCostCents: 300_000 }] }));
});

/** An open outpatient visit with a prescription; answers the order and its medicines' ids. */
async function prescribed(items: Record<string, unknown>[] = [{ drugCode: "PCM-500-TAB", doseAmount: "1", frequency: "tds", durationDays: 5 }]) {
  const patientId = await h.patient();
  const visit = await created(await post("/encounters", h.nurse, { patientId, kind: "opd" }));
  const order = await created(await post(`/encounters/${visit.id}/prescriptions`, doctor, { items }));
  // A medicine goes by its catalogue code.
  const given = order.items as { id: string; code: string }[];
  return { patientId, encounterId: visit.id as string, orderId: order.id as string, medicines: given.map(i => i.id), byDrug: new Map(given.map(i => [i.code, i.id])) };
}

const prepare = (body: Record<string, unknown>, who: StaffMember = pharmacist) => post("/dispenses", who, body);

async function refusal(res: Response, status = 409): Promise<string> {
  expect(res.status).toBe(status);
  return (await res.json()).code;
}

async function shelf(): Promise<number> {
  const items = (await (await call("GET", `/stores/${pharmacy}/stock`, h.facility.id, storekeeper)).json()).items;
  return items.find((i: { stockItemId: string }) => i.stockItemId === paracetamol)?.onHand ?? 0;
}

async function medicineStatus(id: string): Promise<string> {
  return (await db.select({ status: orderItems.status }).from(orderItems).where(eq(orderItems.id, id)))[0].status;
}

describe("dispensing a prescription", () => {
  it("is prepared from the pharmacy's stock with its charge, then handed over, finishing the medicine", async () => {
    const rx = await prescribed();
    const list = await (await call("GET", "/pharmacy/worklist", h.facility.id, pharmacist)).json();
    expect(list.waiting).toEqual([expect.objectContaining({ orderId: rx.orderId, number: expect.stringMatching(/^RX-/), medicines: [expect.objectContaining({ quantity: 15, given: 0, prepared: false })] })]);

    const dispense = await created(await prepare({ orderId: rx.orderId, lines: [{ orderItemId: rx.medicines[0], stockItemId: paracetamol }] }));

    expect(dispense).toMatchObject({ status: "prepared", unpaid: true, store: { name: "Pharmacy" } });
    // 15 tablets at KES 2.50 is KES 37.50, charged as KES 38: whole shillings, once.
    expect(dispense.lines).toEqual([expect.objectContaining({ quantity: 15, completes: true, amountCents: 3800, batches: [expect.objectContaining({ batchNumber: "P1", quantity: 15 })] })]);
    expect(await shelf()).toBe(2985);
    expect(await medicineStatus(rx.medicines[0])).toBe("ordered");
    const waiting = await (await call("GET", "/pharmacy/worklist", h.facility.id, pharmacist)).json();
    expect(waiting.waiting[0].medicines[0].prepared).toBe(true);
    expect(waiting.prepared.map((d: { id: string }) => d.id)).toEqual([dispense.id]);

    const handed = await (await post(`/dispenses/${dispense.id}/hand-over`, pharmTech)).json();
    expect(handed).toMatchObject({ status: "handed_over", unpaid: true, handedOver: { byName: "Test User" } });
    expect(await medicineStatus(rx.medicines[0])).toBe("done");
    expect((await (await call("GET", "/pharmacy/worklist", h.facility.id, pharmacist)).json()).waiting).toEqual([]);
    const actions = (await db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, rx.encounterId))).map(a => a.action);
    expect(actions).toEqual(expect.arrayContaining(["dispense.prepared", "dispense.handed_over"]));
  });

  it("gives a medicine in parts, never more than is owed", async () => {
    const rx = await prescribed();
    const line = (extra: Record<string, unknown> = {}) => ({ orderId: rx.orderId, lines: [{ orderItemId: rx.medicines[0], stockItemId: paracetamol, ...extra }] });

    expect((await (await prepare(line({ quantity: 16 }))).json()).code).toBe("more_than_owed");
    const first = await created(await prepare(line({ quantity: 10 })));
    expect(first.lines[0].completes).toBe(false);
    expect(await refusal(await prepare(line({ quantity: 5 })))).toBe("already_prepared");
    await post(`/dispenses/${first.id}/hand-over`, pharmacist);
    expect(await medicineStatus(rx.medicines[0])).toBe("ordered");

    expect(await refusal(await prepare(line({ quantity: 6 })))).toBe("more_than_owed");
    const rest = await created(await prepare(line()));
    expect(rest.lines[0]).toMatchObject({ quantity: 5, completes: true });
    await post(`/dispenses/${rest.id}/hand-over`, pharmacist);
    expect(await medicineStatus(rx.medicines[0])).toBe("done");
    expect(await refusal(await prepare(line()))).toBe("medicine_finished");
  });

  it("asks the quantity of an item counted in another unit than the prescription, and lets it finish the medicine", async () => {
    const syrup = await stocked("PCM-SYR", "PCM-120-SUSP", "bottle", 15_000, 10);
    const rx = await prescribed([{ drugCode: "PCM-120-SUSP", doseAmount: "5", frequency: "tds", durationDays: 5 }]);
    const line = (extra: Record<string, unknown> = {}) => ({ orderId: rx.orderId, lines: [{ orderItemId: rx.medicines[0], stockItemId: syrup, ...extra }] });

    expect(await refusal(await prepare(line()))).toBe("quantity_needed");
    const dispense = await created(await prepare(line({ quantity: 1 })));

    expect(dispense.lines[0]).toMatchObject({ quantity: 1, completes: true, amountCents: 15_000 });
  });

  it("refuses the wrong drug, an unpriced item, a store that is not a pharmacy, and a closed visit", async () => {
    const amoxil = await stocked("AMX-500", "AMX-500-CAP", "capsule", 500, 100);
    const unpriced = await stocked("PCM-B", "PCM-500-TAB", "tablet", null, 100);
    const main = (await created(await post("/stores", h.admin, { name: "Main store", kind: "main" }))).id;
    const rx = await prescribed();
    const line = (stockItemId: string, extra: Record<string, unknown> = {}) => ({ orderId: rx.orderId, lines: [{ orderItemId: rx.medicines[0], stockItemId }], ...extra });

    expect(await refusal(await prepare(line(amoxil)))).toBe("wrong_drug");
    expect(await refusal(await prepare(line(unpriced)))).toBe("not_priced");
    expect(await refusal(await prepare(line(paracetamol, { storeId: main })))).toBe("not_a_pharmacy");
    await post("/stores", h.admin, { name: "IPD pharmacy", kind: "pharmacy" });
    expect(await refusal(await prepare(line(paracetamol)))).toBe("store_needed");
    expect((await prepare(line(paracetamol, { storeId: pharmacy }))).status).toBe(201);

    const other = await prescribed();
    await post(`/encounters/${other.encounterId}/close`, h.nurse, {});
    expect(await refusal(await prepare({ orderId: other.orderId, storeId: pharmacy, lines: [{ orderItemId: other.medicines[0], stockItemId: paracetamol }] }))).toBe("visit_closed");
  });

  it("asks the quantity again once some was given in another unit, never subtracting one from the other", async () => {
    const bottles = await stocked("PCM-SYR", "PCM-120-SUSP", "bottle", 15_000, 10);
    const loose = await stocked("PCM-ML", "PCM-120-SUSP", "mL", 100, 500);
    const rx = await prescribed([{ drugCode: "PCM-120-SUSP", doseAmount: "5", frequency: "tds", durationDays: 5 }]);
    const line = (stockItemId: string, extra: Record<string, unknown> = {}) => ({ orderId: rx.orderId, lines: [{ orderItemId: rx.medicines[0], stockItemId, ...extra }] });

    const first = await created(await prepare(line(bottles, { quantity: 1, complete: false })));
    await post(`/dispenses/${first.id}/hand-over`, pharmacist);

    // One bottle is not 1 mL of the 75 mL prescribed.
    expect(await refusal(await prepare(line(loose)))).toBe("quantity_needed");
    const rest = await created(await prepare(line(loose, { quantity: 30 })));
    expect(rest.lines[0]).toMatchObject({ quantity: 30, completes: true });
  });

  it("gives a controlled drug only from a pharmacist with a pharmacy licence", async () => {
    const morphine = await stocked("MOR-10", "MOR-10-INJ", "mL", 10_000, 50);
    const nursePharmTech = await staff(["nurse", "pharm_tech"]);
    const rx = await prescribed([{ drugCode: "MOR-10-INJ", doseAmount: "1", frequency: "stat" }]);
    const body = { orderId: rx.orderId, lines: [{ orderItemId: rx.medicines[0], stockItemId: morphine }] };

    expect(await refusal(await prepare(body, pharmTech), 403)).toBe("controlled_dispenser");
    expect(await refusal(await prepare(body, nursePharmTech), 403)).toBe("controlled_dispenser");
    const dispense = await created(await prepare(body, pharmacist));
    // Nor is it handed over by anyone else.
    expect(await refusal(await post(`/dispenses/${dispense.id}/hand-over`, pharmTech), 403)).toBe("controlled_dispenser");
    expect((await post(`/dispenses/${dispense.id}/hand-over`, pharmacist)).status).toBe(200);
  });

  it("is done by pharmacists and pharmacy technicians alone", async () => {
    const rx = await prescribed();

    expect((await call("GET", "/pharmacy/worklist", h.facility.id, h.nurse)).status).toBe(403);
    expect((await call("GET", "/pharmacy/worklist", h.facility.id, storekeeper)).status).toBe(403);
    expect((await prepare({ orderId: rx.orderId, lines: [{ orderItemId: rx.medicines[0], stockItemId: paracetamol }] }, doctor)).status).toBe(403);
    // What is not there answers as nothing.
    expect((await prepare({ orderId: randomUUID(), lines: [{ orderItemId: rx.medicines[0], stockItemId: paracetamol }] })).status).toBe(404);
    expect((await post(`/order-items/${randomUUID()}/not-supplied`, pharmacist, { reason: "out_of_stock" })).status).toBe(404);
  });

  it("audits opening a dispense on its own, as it names the patient", async () => {
    const rx = await prescribed();
    const dispense = await created(await prepare({ orderId: rx.orderId, lines: [{ orderItemId: rx.medicines[0], stockItemId: paracetamol }] }));

    expect((await call("GET", `/dispenses/${dispense.id}`, h.facility.id, pharmTech)).status).toBe(200);

    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "dispense.viewed"));
    expect(entry).toMatchObject({ actorId: pharmTech.id, entityId: rx.encounterId, detail: { dispenseId: dispense.id } });
  });
});

describe("a prepared dispense", () => {
  it("is cancelled with its stock put back and its charge cancelled, while unbilled", async () => {
    const rx = await prescribed();
    const dispense = await created(await prepare({ orderId: rx.orderId, lines: [{ orderItemId: rx.medicines[0], stockItemId: paracetamol }] }));

    const cancelled = await (await post(`/dispenses/${dispense.id}/cancel`, pharmacist, { reason: "Patient left" })).json();

    expect(cancelled).toMatchObject({ status: "cancelled", unpaid: false, cancelled: { reason: "Patient left" } });
    expect(await shelf()).toBe(3000);
    const [charge] = await db.select().from(charges).where(eq(charges.encounterId, rx.encounterId));
    expect(charge.cancellationReason).toBe("Patient left");
    expect(await refusal(await post(`/dispenses/${dispense.id}/hand-over`, pharmacist))).toBe("not_prepared");
    // The medicine is back on the list, to prepare again.
    expect((await prepare({ orderId: rx.orderId, lines: [{ orderItemId: rx.medicines[0], stockItemId: paracetamol }] })).status).toBe(201);
  });

  it("cannot be cancelled once its charge is on a bill, and holds its prescription from being cancelled", async () => {
    const rx = await prescribed();
    const dispense = await created(await prepare({ orderId: rx.orderId, lines: [{ orderItemId: rx.medicines[0], stockItemId: paracetamol }] }));

    expect(await refusal(await post(`/prescriptions/${rx.orderId}/cancel`, doctor, { reason: "Changed my mind" }))).toBe("being_dispensed");
    const bill = await post(`/encounters/${rx.encounterId}/bill-now`, h.cashier);
    expect(bill.status).toBe(201);

    expect(await refusal(await post(`/dispenses/${dispense.id}/cancel`, pharmacist, { reason: "Patient left" }))).toBe("billed");
  });
});

describe("a medicine not supplied", () => {
  it("is ended with a reason and no charge, and never while it is prepared", async () => {
    const rx = await prescribed([
      { drugCode: "PCM-500-TAB", doseAmount: "1", frequency: "tds", durationDays: 5 },
      { drugCode: "AMX-500-CAP", doseAmount: "1", frequency: "tds", durationDays: 5 },
    ]);
    const notSupplied = (id: string, body: Record<string, unknown>) => post(`/order-items/${id}/not-supplied`, pharmTech, body);
    const [pcm, amx] = ["PCM-500-TAB", "AMX-500-CAP"].map(code => rx.byDrug.get(code)!);

    expect((await notSupplied(amx, { reason: "other" })).status).toBe(422);
    expect((await notSupplied(amx, { reason: "out_of_stock" })).status).toBe(204);
    expect(await medicineStatus(amx)).toBe("done");
    expect(await refusal(await notSupplied(amx, { reason: "out_of_stock" }))).toBe("medicine_finished");

    await created(await prepare({ orderId: rx.orderId, lines: [{ orderItemId: pcm, stockItemId: paracetamol }] }));
    expect(await refusal(await notSupplied(pcm, { reason: "patient_declined" }))).toBe("already_prepared");
    const charged = await db.select().from(charges).where(and(eq(charges.encounterId, rx.encounterId)));
    expect(charged).toHaveLength(1);
  });
});
