import { sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { Hospital, StaffMember } from "@/test/hospital";

import db from "@/db";
import { addDays, businessDate } from "@/lib/dates";
import { pgErrorCode } from "@/lib/db-errors";
import { loadDrugCatalogue } from "@/lib/drug-catalogue-load";
import { addMembership, resetDb, signedInUser } from "@/test/helpers";
import { call, hospital, TODAY } from "@/test/hospital";

/** P4 slice 5: stock takes. */

const SAMPLE = path.resolve(import.meta.dirname, "../test/fixtures/drug-catalogue-sample.csv");

let h: Hospital;
let pharmacist: StaffMember;
let storekeeper: StaffMember;
let pharmacy: string;
let main: string;
let paracetamol: string;
/** Paracetamol in the pharmacy: 3,000 tablets. */
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
const count = (id: string, counts: unknown[], who: StaffMember = storekeeper) => call("PUT", `/stock-takes/${id}/counts`, h.facility.id, who, { counts });

async function refusal(res: Response, status = 409): Promise<string> {
  expect(res.status).toBe(status);
  return (await res.json()).code;
}

async function shelf(store = pharmacy): Promise<number> {
  const items = (await (await call("GET", `/stores/${store}/stock`, h.facility.id, storekeeper)).json()).items;
  return items.find((i: { stockItemId: string }) => i.stockItemId === paracetamol)?.onHand ?? 0;
}

beforeEach(async () => {
  await resetDb();
  await loadDrugCatalogue(await readFile(SAMPLE, "utf8"));
  h = await hospital();
  pharmacist = await staff(["pharmacist"]);
  storekeeper = await staff(["storekeeper"]);
  pharmacy = (await created(await post("/stores", h.admin, { name: "Pharmacy", kind: "pharmacy" }))).id;
  main = (await created(await post("/stores", h.admin, { name: "Main store", kind: "main" }))).id;
  paracetamol = (await created(await post("/stock-items", h.admin, { billableItemId: h.items.tablet, drugCode: "PCM-500-TAB", baseUnit: "tablet", packSize: 100 }))).id;
  const note = await created(await post("/goods-received", storekeeper, { storeId: pharmacy, supplier: "MEDS", lines: [{ stockItemId: paracetamol, batchNumber: "P1", expiresOn: inDays(300), units: 3000, totalCostCents: 300_000 }] }));
  p1 = note.items[0].batchId;
});

describe("a stock take", () => {
  it("is counted blind, and its differences become one correction a second person approves", async () => {
    const take = await created(await post("/stock-takes", storekeeper, { storeId: pharmacy }));
    expect(take).toMatchObject({ number: `STK-${businessDate().slice(0, 4)}-000001`, scope: "store", status: "counting" });
    // The sheet names the batch, never what is expected of it.
    expect(take.lines).toEqual([expect.objectContaining({ batchId: p1, batchNumber: "P1", counted: null, expected: null })]);

    expect(await refusal(await post(`/stock-takes/${take.id}/submit`, storekeeper))).toBe("uncounted");
    await count(take.id, [{ batchId: p1, quantity: 2990 }]);
    const submitted = await (await post(`/stock-takes/${take.id}/submit`, storekeeper)).json();

    expect(submitted).toMatchObject({ status: "submitted", adjustmentId: expect.any(String), lines: [expect.objectContaining({ counted: 2990, expected: 3000, difference: -10 })] });
    const adjustment = await (await call("GET", `/stock-adjustments?status=pending`, h.facility.id, h.finance)).json();
    expect(adjustment.adjustments).toEqual([expect.objectContaining({ id: submitted.adjustmentId, kind: "correction", reason: `Stock take ${take.number}`, lines: [expect.objectContaining({ quantity: -10 })] })]);
    expect(await shelf()).toBe(3000);
    expect(await refusal(await post(`/stock-adjustments/${submitted.adjustmentId}/approve`, storekeeper), 403)).toBeUndefined();
    await post(`/stock-adjustments/${submitted.adjustmentId}/approve`, h.finance);
    expect(await shelf()).toBe(2990);
  });

  it("expects what the store held as each line was counted, whatever moves after", async () => {
    const take = await created(await post("/stock-takes", storekeeper, { storeId: pharmacy }));
    await count(take.id, [{ batchId: p1, quantity: 3000 }]);
    // The store stays open: 100 leave after the count.
    await created(await post("/stock-transfers/send", storekeeper, { fromStoreId: pharmacy, toStoreId: main, lines: [{ stockItemId: paracetamol, quantity: 100 }] }));

    const submitted = await (await post(`/stock-takes/${take.id}/submit`, storekeeper)).json();

    expect(submitted).toMatchObject({ adjustmentId: null, lines: [expect.objectContaining({ counted: 3000, expected: 3000, difference: 0 })] });
  });

  it("adds a batch found on the shelf, one open count per store at a time", async () => {
    const other = await created(await post("/goods-received", storekeeper, { storeId: main, supplier: "MEDS", lines: [{ stockItemId: paracetamol, batchNumber: "M1", expiresOn: inDays(200), units: 50, totalCostCents: 5000 }] }));
    const take = await created(await post("/stock-takes", storekeeper, { storeId: pharmacy, stockItemIds: [paracetamol] }));
    expect(await refusal(await post("/stock-takes", pharmacist, { storeId: pharmacy }))).toBe("count_open");

    // Five of main store's batch turn up on the pharmacy's shelf.
    await count(take.id, [{ batchId: p1, quantity: 3000 }, { batchId: other.items[0].batchId, quantity: 5 }]);
    const submitted = await (await post(`/stock-takes/${take.id}/submit`, storekeeper)).json();

    expect(submitted.lines.map((l: Record<string, unknown>) => [l.batchNumber, l.expected, l.difference])).toEqual([["M1", 0, 5], ["P1", 3000, 0]]);
    expect((await post("/stock-takes", pharmacist, { storeId: pharmacy })).status).toBe(201);
  });

  it("with a controlled drug is submitted by a pharmacist, and a nurse counts only a ward's store", async () => {
    const morphineItem = (await created(await post("/billable-items", h.admin, { code: "MOR-10", name: "Morphine", category: "drug" }))).id;
    const change = await (await post("/price-changes", h.admin, { effectiveFrom: TODAY, reason: "Tariff", lines: [{ billableItemId: morphineItem, unitPriceCents: 10_000 }] })).json();
    await post(`/price-changes/${change.id}/approve`, h.finance);
    const morphine = (await created(await post("/stock-items", h.admin, { billableItemId: morphineItem, drugCode: "MOR-10-INJ", baseUnit: "mL", packSize: 1 }))).id;
    const note = await created(await post("/goods-received", storekeeper, { storeId: main, supplier: "KEMSA", lines: [{ stockItemId: morphine, batchNumber: "M1", expiresOn: inDays(300), units: 20, totalCostCents: 2000 }] }));
    const take = await created(await post("/stock-takes", storekeeper, { storeId: main }));
    await count(take.id, [{ batchId: note.items[0].batchId, quantity: 19 }]);

    expect(await refusal(await post(`/stock-takes/${take.id}/submit`, storekeeper), 403)).toBe("controlled_dispenser");
    expect((await post(`/stock-takes/${take.id}/submit`, pharmacist)).status).toBe(200);

    const nurse = await staff(["ward_nurse"]);
    expect(await refusal(await post("/stock-takes", nurse, { storeId: pharmacy }), 403)).toBe("ward_store_only");
  });

  it("is cancelled while open, and final once submitted, for every role", async () => {
    const take = await created(await post("/stock-takes", storekeeper, { storeId: pharmacy }));
    expect((await (await post(`/stock-takes/${take.id}/cancel`, storekeeper, { reason: "Started in the wrong store" })).json()).status).toBe("cancelled");
    expect(await refusal(await count(take.id, [{ batchId: p1, quantity: 1 }]))).toBe("not_counting");

    const next = await created(await post("/stock-takes", storekeeper, { storeId: pharmacy }));
    await count(next.id, [{ batchId: p1, quantity: 3000 }]);
    await post(`/stock-takes/${next.id}/submit`, storekeeper);
    const edit = await db.execute(sql`UPDATE stock_take_lines SET counted_quantity = 1 WHERE stock_take_id = ${next.id}`).then(() => null, (e: unknown) => e);
    expect(pgErrorCode(edit)).toBe("23001");
    const reopen = await db.execute(sql`UPDATE stock_takes SET status = 'counting', submitted_by = NULL, submitted_at = NULL WHERE id = ${next.id}`).then(() => null, (e: unknown) => e);
    expect(pgErrorCode(reopen)).toBe("23001");
  });
});
