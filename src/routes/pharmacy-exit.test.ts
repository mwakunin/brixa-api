import { sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { Hospital, StaffMember } from "@/test/hospital";

import db from "@/db";
import { runAsFacility } from "@/db/tenant-transaction";
import { addDays, businessDate } from "@/lib/dates";
import { loadDrugCatalogue } from "@/lib/drug-catalogue-load";
import { reconcile } from "@/lib/reconciliation";
import { addMembership, resetDb, signedInUser } from "@/test/helpers";
import { call, hospital, TODAY } from "@/test/hospital";

/**
 * The P4 exit (ROADMAP.md P4, slice 6): a week of the stores through the API
 * (deliveries, transfers to the pharmacy and a ward, dispensing with a
 * cancellation and a return, a write-off and a stock take), then the stock
 * identity and the controlled-drug register checked for every store and batch.
 */

const SAMPLE = path.resolve(import.meta.dirname, "../test/fixtures/drug-catalogue-sample.csv");

let h: Hospital;
let doctor: StaffMember;
let pharmacist: StaffMember;
let storekeeper: StaffMember;
let wardNurse: StaffMember;
let main: string;
let pharmacy: string;
let ward: string;
let paracetamol: string;
let morphine: string;

const inDays = (days: number) => addDays(businessDate(), days);

async function staff(roles: Parameters<typeof addMembership>[2], licence?: string): Promise<StaffMember> {
  const user = await signedInUser();
  const membership = await addMembership(user.id, h.facility.id, roles, licence ? { licence: { number: licence, expiresOn: inDays(365) } } : {});
  return { ...user, actor: { userId: user.id, membershipId: membership.id } };
}

async function api(method: string, route: string, who: StaffMember, body?: unknown) {
  const res = await call(method, route, h.facility.id, who, body);
  expect(res.status, `${method} ${route}`).toBeLessThan(300);
  return res.json();
}

/** A visit with one medicine prescribed, prepared at the pharmacy. */
async function prepared(drugCode: string, stockItemId: string, dose: Record<string, unknown>) {
  const patientId = await h.patient();
  const visit = await api("POST", "/encounters", h.nurse, { patientId, kind: "opd" });
  const order = await api("POST", `/encounters/${visit.id}/prescriptions`, doctor, { items: [{ drugCode, ...dose }] });
  const dispense = await api("POST", "/dispenses", pharmacist, { orderId: order.id, storeId: pharmacy, lines: [{ orderItemId: order.items[0].id, stockItemId }] });
  return { patientId, encounterId: visit.id as string, dispense };
}

beforeEach(async () => {
  await resetDb();
  await loadDrugCatalogue(await readFile(SAMPLE, "utf8"));
  h = await hospital();
  doctor = await staff(["doctor"], "KMPDC-111");
  pharmacist = await staff(["pharmacist"], "PPB-222");
  storekeeper = await staff(["storekeeper"]);
  wardNurse = await staff(["ward_nurse"], "NCK-333");
  main = (await api("POST", "/stores", h.admin, { name: "Main store", kind: "main" })).id;
  pharmacy = (await api("POST", "/stores", h.admin, { name: "Pharmacy", kind: "pharmacy" })).id;
  ward = (await api("POST", "/stores", h.admin, { name: "Ward 1", kind: "ward" })).id;
  paracetamol = (await api("POST", "/stock-items", h.admin, { billableItemId: h.items.tablet, drugCode: "PCM-500-TAB", baseUnit: "tablet", packSize: 100 })).id;
  const morphineItem = (await api("POST", "/billable-items", h.admin, { code: "MOR-10", name: "Morphine 10 mg/mL", category: "drug" })).id;
  const change = await api("POST", "/price-changes", h.admin, { effectiveFrom: TODAY, reason: "Tariff", lines: [{ billableItemId: morphineItem, unitPriceCents: 10_000 }] });
  await api("POST", `/price-changes/${change.id}/approve`, h.finance);
  morphine = (await api("POST", "/stock-items", h.admin, { billableItemId: morphineItem, drugCode: "MOR-10-INJ", baseUnit: "mL", packSize: 1 })).id;
});

describe("the stores (the P4 exit)", () => {
  it("keep on hand the sum of movements, never negative, for every store and batch, and the register balanced", async () => {
    // --- Deliveries into the main store ---
    await api("POST", "/goods-received", storekeeper, {
      storeId: main,
      supplier: "KEMSA",
      lines: [
        { stockItemId: paracetamol, batchNumber: "P1", expiresOn: inDays(60), units: 1000, totalCostCents: 100_000 },
        { stockItemId: paracetamol, batchNumber: "P2", expiresOn: inDays(400), units: 2000, totalCostCents: 200_000 },
        { stockItemId: morphine, batchNumber: "M1", expiresOn: inDays(300), units: 50, totalCostCents: 50_000 },
      ],
    });

    // --- Transfers: the pharmacy, earliest expiry first; a ward, received by its nurse ---
    const toPharmacy = await api("POST", "/stock-transfers/send", storekeeper, { fromStoreId: main, toStoreId: pharmacy, lines: [{ stockItemId: paracetamol, quantity: 1500 }, { stockItemId: morphine, quantity: 20 }] });
    await api("POST", `/stock-transfers/${toPharmacy.id}/receive`, pharmacist, {});
    const toWard = await api("POST", "/stock-transfers/send", storekeeper, { fromStoreId: main, toStoreId: ward, lines: [{ stockItemId: paracetamol, quantity: 100 }] });
    await api("POST", `/stock-transfers/${toWard.id}/receive`, wardNurse, {});

    // --- Dispensing: handed over, cancelled, and part of one brought back ---
    const tablets = await prepared("PCM-500-TAB", paracetamol, { doseAmount: "1", frequency: "tds", durationDays: 5 });
    await api("POST", `/dispenses/${tablets.dispense.id}/hand-over`, pharmacist);
    await api("POST", `/dispense-lines/${tablets.dispense.lines[0].id}/returns`, pharmacist, { quantity: 5, reason: "Stopped by the doctor", fitForResale: true });
    const injection = await prepared("MOR-10-INJ", morphine, { doseAmount: "2", frequency: "stat" });
    await api("POST", `/dispenses/${injection.dispense.id}/hand-over`, pharmacist);
    const uncollected = await prepared("PCM-500-TAB", paracetamol, { doseAmount: "2", frequency: "tds", durationDays: 3 });
    await api("POST", `/dispenses/${uncollected.dispense.id}/cancel`, pharmacist, { reason: "Patient left" });

    // --- A write-off and a stock take, each approved by a second person ---
    const stock = (store: string) => api("GET", `/stores/${store}/stock`, h.finance).then(s => s.items as { stockItemId: string; onHand: number; batches: { batchId: string; batchNumber: string; onHand: number }[] }[]);
    const p1 = (await stock(pharmacy)).find(i => i.stockItemId === paracetamol)!.batches.find(b => b.batchNumber === "P1")!;
    const writeOff = await api("POST", "/stock-adjustments", storekeeper, { storeId: pharmacy, kind: "damaged", reason: "Wet in the store", lines: [{ batchId: p1.batchId, quantity: -10 }] });
    await api("POST", `/stock-adjustments/${writeOff.id}/approve`, h.finance);
    const take = await api("POST", "/stock-takes", pharmacist, { storeId: pharmacy });
    const counts = (await stock(pharmacy)).flatMap(i => i.batches.map(b => ({ batchId: b.batchId, quantity: b.batchNumber === "P2" ? b.onHand - 4 : b.onHand })));
    await api("PUT", `/stock-takes/${take.id}/counts`, pharmacist, { counts });
    const submitted = await api("POST", `/stock-takes/${take.id}/submit`, pharmacist, {});
    await api("POST", `/stock-adjustments/${submitted.adjustmentId}/approve`, h.finance);

    // --- The identity: what each store shows is the sum of its ledger, per batch, and never below nought ---
    const { rows } = await db.execute(sql`
      SELECT store_id, batch_id, sum(quantity)::int AS on_hand FROM stock_movements
      WHERE facility_id = ${h.facility.id} GROUP BY store_id, batch_id`);
    const ledger = rows as { store_id: string; batch_id: string; on_hand: number }[];
    expect(ledger.filter(r => r.on_hand < 0)).toEqual([]);
    for (const store of [main, pharmacy, ward]) {
      const shown = (await stock(store)).flatMap(i => i.batches.map(b => [b.batchId, b.onHand]));
      const summed = ledger.filter(r => r.store_id === store && r.on_hand > 0).map(r => [r.batch_id, r.on_hand]);
      expect(Object.fromEntries(shown)).toEqual(Object.fromEntries(summed));
    }
    // What came in, less what left the building, is what is held: 1500 tablets to the pharmacy, 15 out and 5 back, 10 damaged, 4 short.
    expect((await stock(pharmacy)).map(i => [i.stockItemId, i.onHand])).toEqual(expect.arrayContaining([[paracetamol, 1476], [morphine, 18]]));
    expect((await stock(main)).map(i => [i.stockItemId, i.onHand])).toEqual(expect.arrayContaining([[paracetamol, 1400], [morphine, 30]]));
    expect((await stock(ward)).map(i => [i.stockItemId, i.onHand])).toEqual([[paracetamol, 100]]);

    // --- The register: each page's balance is the ledger's, and the daily check finds no drift in stock or money ---
    const register = (store: string) => api("GET", `/controlled-register?drugCode=MOR-10-INJ&storeId=${store}`, pharmacist).then(p => p.lines.map((l: { kind: string; balance: number }) => [l.kind, l.balance]));
    expect(await register(main)).toEqual([["receipt", 50], ["transfer_out", 30]]);
    expect(await register(pharmacy)).toEqual([["transfer_in", 20], ["dispense", 18]]);
    expect((await runAsFacility(h.facility.id, tx => reconcile(tx))).drift).toEqual([]);

    // --- The alerts: the batch near its expiry, and morphine below its level, in the pharmacy ---
    await api("PUT", `/stores/${pharmacy}/reorder-levels`, h.admin, { levels: [{ stockItemId: morphine, level: 20 }] });
    const alerts = await api("GET", "/stock-alerts", storekeeper);
    expect(alerts.expiring.map((b: { storeName: string; batchNumber: string }) => [b.storeName, b.batchNumber])).toEqual(expect.arrayContaining([["Pharmacy", "P1"]]));
    expect(alerts.belowReorder).toEqual([expect.objectContaining({ storeName: "Pharmacy", stockItemId: morphine, onHand: 18, reorderLevel: 20 })]);
  });
});
