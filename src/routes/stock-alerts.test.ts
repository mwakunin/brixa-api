import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { Hospital, StaffMember } from "@/test/hospital";

import { runAsFacility } from "@/db/tenant-transaction";
import { addDays, businessDate } from "@/lib/dates";
import { loadDrugCatalogue } from "@/lib/drug-catalogue-load";
import { stockAlerts } from "@/lib/stock-alerts";
import { addMembership, resetDb, signedInUser } from "@/test/helpers";
import { call, hospital } from "@/test/hospital";

/** P4 slice 6: expiry and low-stock alerts, worked out from the ledger when read. */

const SAMPLE = path.resolve(import.meta.dirname, "../test/fixtures/drug-catalogue-sample.csv");

let h: Hospital;
let storekeeper: StaffMember;
let pharmacy: string;
let main: string;
let paracetamol: string;
let amoxicillin: string;
/** Paracetamol in the pharmacy: 100 tablets on their last good day in 90 days. */
let p1: string;
/** And 50 with a day more. */
let p2: string;

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
async function alerts(query = "", who: StaffMember = storekeeper) {
  const res = await call("GET", `/stock-alerts${query}`, h.facility.id, who);
  expect(res.status).toBe(200);
  return res.json();
}

async function received(storeId: string, stockItemId: string, batchNumber: string, expiresOn: string, units: number): Promise<string> {
  const note = await created(await post("/goods-received", storekeeper, { storeId, supplier: "MEDS", lines: [{ stockItemId, batchNumber, expiresOn, units, totalCostCents: units * 100 }] }));
  return note.items[0].batchId;
}

beforeEach(async () => {
  await resetDb();
  await loadDrugCatalogue(await readFile(SAMPLE, "utf8"));
  h = await hospital();
  storekeeper = await staff(["storekeeper"]);
  pharmacy = (await created(await post("/stores", h.admin, { name: "Pharmacy", kind: "pharmacy" }))).id;
  main = (await created(await post("/stores", h.admin, { name: "Main store", kind: "main" }))).id;
  paracetamol = (await created(await post("/stock-items", h.admin, { billableItemId: h.items.tablet, drugCode: "PCM-500-TAB", baseUnit: "tablet", packSize: 100 }))).id;
  const amoxItem = (await created(await post("/billable-items", h.admin, { code: "AMX-500", name: "Amoxicillin 500 mg", category: "drug" }))).id;
  amoxicillin = (await created(await post("/stock-items", h.admin, { billableItemId: amoxItem, drugCode: "AMX-500-CAP", baseUnit: "capsule", packSize: 100 }))).id;
  p1 = await received(pharmacy, paracetamol, "P1", inDays(90), 100);
  p2 = await received(pharmacy, paracetamol, "P2", inDays(91), 50);
});

describe("stock alerts", () => {
  it("flag a batch 90 days before it expires and an item below its store's reorder level, stock on its way shown beside", async () => {
    await received(main, paracetamol, "M1", inDays(300), 40);
    expect((await call("PUT", `/stores/${pharmacy}/reorder-levels`, h.facility.id, h.admin, { levels: [{ stockItemId: paracetamol, level: 200 }, { stockItemId: amoxicillin, level: 10 }] })).status).toBe(200);
    // Nought flags nothing, and an item at its level is not below it.
    expect((await call("PUT", `/stores/${main}/reorder-levels`, h.facility.id, h.admin, { levels: [{ stockItemId: paracetamol, level: 0 }, { stockItemId: amoxicillin, level: 0 }] })).status).toBe(200);
    // Thirty of main store's are on their way to the pharmacy, not received yet.
    await created(await post("/stock-transfers/send", storekeeper, { fromStoreId: main, toStoreId: pharmacy, lines: [{ stockItemId: paracetamol, quantity: 30 }] }));

    const all = await alerts();

    expect(all.expired).toEqual([]);
    expect(all.expiring).toEqual([expect.objectContaining({ storeId: pharmacy, storeName: "Pharmacy", stockItemId: paracetamol, code: "PCM-500", batchId: p1, batchNumber: "P1", expiresOn: inDays(90), daysLeft: 90, onHand: 100 })]);
    expect(all.belowReorder).toEqual([
      { storeId: pharmacy, storeName: "Pharmacy", stockItemId: amoxicillin, code: "AMX-500", name: "Amoxicillin 500 mg", baseUnit: "capsule", onHand: 0, reorderLevel: 10, inTransit: 0 },
      { storeId: pharmacy, storeName: "Pharmacy", stockItemId: paracetamol, code: "PCM-500", name: "PCM-500", baseUnit: "tablet", onHand: 150, reorderLevel: 200, inTransit: 30 },
    ]);
    // One store's alone.
    expect(await alerts(`?storeId=${main}`)).toEqual({ expired: [], expiring: [], belowReorder: [] });
  });

  it("list an expired batch still held, to write off, until it is written off", async () => {
    const later = inDays(91);
    const seen = await runAsFacility(h.facility.id, tx => stockAlerts(tx, {}, later));
    expect(seen.expired).toEqual([expect.objectContaining({ batchId: p1, daysLeft: -1, onHand: 100 })]);
    expect(seen.expiring).toEqual([expect.objectContaining({ batchId: p2, daysLeft: 0, onHand: 50 })]);

    const writeOff = await created(await post("/stock-adjustments", storekeeper, { storeId: pharmacy, kind: "damaged", reason: "Crushed in the store", lines: [{ batchId: p1, quantity: -100 }] }));
    // Asked for, not yet approved: still on the shelf, still listed.
    expect((await runAsFacility(h.facility.id, tx => stockAlerts(tx, {}, later))).expired).toHaveLength(1);
    expect((await post(`/stock-adjustments/${writeOff.id}/approve`, h.finance)).status).toBe(200);

    expect((await runAsFacility(h.facility.id, tx => stockAlerts(tx, {}, later))).expired).toEqual([]);
  });

  it("are read by those who read stock, for a store that is there", async () => {
    for (const who of [h.admin, h.finance, h.auditor, await staff(["pharm_tech"])])
      expect((await call("GET", "/stock-alerts", h.facility.id, who)).status).toBe(200);
    for (const who of [h.nurse, h.cashier, await staff(["ward_nurse"])])
      expect((await call("GET", "/stock-alerts", h.facility.id, who)).status).toBe(403);
    expect((await call("GET", "/stock-alerts?storeId=00000000-0000-4000-8000-000000000000", h.facility.id, storekeeper)).status).toBe(404);
  });
});
