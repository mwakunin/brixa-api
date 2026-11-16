import { sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { Hospital, StaffMember } from "@/test/hospital";

import db from "@/db";
import { runAsFacility } from "@/db/tenant-transaction";
import { addDays, businessDate } from "@/lib/dates";
import { pgErrorCode } from "@/lib/db-errors";
import { loadDrugCatalogue } from "@/lib/drug-catalogue-load";
import { submitStockTake } from "@/lib/stock-takes";
import { sendDirect } from "@/lib/transfers";
import { addMembership, backendPid, resetDb, signedInUser, waitForBlockedBackend } from "@/test/helpers";
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

  it("expects what the ledger held, committed, as a line was counted: a movement begun before and committed after is not on the sheet", async () => {
    const take = await created(await post("/stock-takes", storekeeper, { storeId: pharmacy }));
    await runAsFacility(h.facility.id, async (tx) => {
      await sendDirect(tx, h.facility.id, { fromStoreId: pharmacy, toStoreId: main, lines: [{ stockItemId: paracetamol, quantity: 100 }] }, { ...storekeeper.actor, roles: ["storekeeper"] });
      // The transfer is not done as the shelf is counted: 3,000 are there.
      expect((await count(take.id, [{ batchId: p1, quantity: 3000 }])).status).toBe(200);
    });

    const submitted = await (await post(`/stock-takes/${take.id}/submit`, storekeeper)).json();

    expect(submitted).toMatchObject({ adjustmentId: null, lines: [expect.objectContaining({ counted: 3000, expected: 3000, difference: 0 })] });
  });

  it("is not opened again while the last count's correction waits, and stock gone since it was counted is counted again", async () => {
    const first = await created(await post("/stock-takes", storekeeper, { storeId: pharmacy }));
    await count(first.id, [{ batchId: p1, quantity: 2990 }]);
    const submitted = await (await post(`/stock-takes/${first.id}/submit`, storekeeper)).json();

    // Counted again now, the same ten would be asked for twice.
    expect(await refusal(await post("/stock-takes", storekeeper, { storeId: pharmacy }))).toBe("correction_pending");
    await post(`/stock-adjustments/${submitted.adjustmentId}/approve`, h.finance);
    const second = await created(await post("/stock-takes", storekeeper, { storeId: pharmacy }));

    // Ten short on the shelf, then all but five leave before the count is submitted: the correction cannot be made.
    await count(second.id, [{ batchId: p1, quantity: 2980 }]);
    await created(await post("/stock-transfers/send", storekeeper, { fromStoreId: pharmacy, toStoreId: main, lines: [{ stockItemId: paracetamol, quantity: 2985 }] }));
    expect(await refusal(await post(`/stock-takes/${second.id}/submit`, storekeeper))).toBe("not_enough_stock");
  });

  it("adds a batch found on the shelf, one open count per store at a time", async () => {
    const other = await created(await post("/goods-received", storekeeper, { storeId: main, supplier: "MEDS", lines: [{ stockItemId: paracetamol, batchNumber: "M1", expiresOn: inDays(200), units: 50, totalCostCents: 5000 }] }));
    const take = await created(await post("/stock-takes", storekeeper, { storeId: pharmacy, stockItemIds: [paracetamol] }));
    expect(await refusal(await post("/stock-takes", pharmacist, { storeId: pharmacy }))).toBe("count_open");

    // Five of main store's batch turn up on the pharmacy's shelf.
    await count(take.id, [{ batchId: p1, quantity: 3000 }, { batchId: other.items[0].batchId, quantity: 5 }]);
    const submitted = await (await post(`/stock-takes/${take.id}/submit`, storekeeper)).json();

    expect(submitted.lines.map((l: Record<string, unknown>) => [l.batchNumber, l.expected, l.difference])).toEqual([["M1", 0, 5], ["P1", 3000, 0]]);
    expect((await post(`/stock-adjustments/${submitted.adjustmentId}/approve`, h.finance)).status).toBe(200);
    expect((await post("/stock-takes", pharmacist, { storeId: pharmacy })).status).toBe(201);
  });

  it("with a controlled drug is submitted by a pharmacist, and a nurse counts only a ward's store", async () => {
    const morphineItem = (await created(await post("/billable-items", h.admin, { code: "MOR-10", name: "Morphine", category: "drug" }))).id;
    const change = await (await post("/price-changes", h.admin, { effectiveFrom: TODAY, reason: "Tariff", lines: [{ billableItemId: morphineItem, unitPriceCents: 10_000 }] })).json();
    await post(`/price-changes/${change.id}/approve`, h.finance);
    const morphine = (await created(await post("/stock-items", h.admin, { billableItemId: morphineItem, drugCode: "MOR-10-INJ", baseUnit: "mL", packSize: 1 }))).id;
    const note = await created(await post("/goods-received", storekeeper, { storeId: main, supplier: "KEMSA", lines: [{ stockItemId: morphine, batchNumber: "M1", expiresOn: inDays(300), units: 20, totalCostCents: 2000 }] }));
    const take = await created(await post("/stock-takes", storekeeper, { storeId: main }));
    await count(take.id, [{ batchId: note.items[0].batchId, quantity: 20 }]);

    // Though nothing differs.
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
    expect((await count(next.id, [{ batchId: p1, quantity: 3000 }])).status).toBe(200);
    expect((await post(`/stock-takes/${next.id}/submit`, storekeeper)).status).toBe(200);
    const edit = await db.execute(sql`UPDATE stock_take_lines SET counted_quantity = 1 WHERE stock_take_id = ${next.id}`).then(() => null, (e: unknown) => e);
    expect(pgErrorCode(edit)).toBe("23001");
    const reopen = await db.execute(sql`UPDATE stock_takes SET status = 'counting', submitted_by = NULL, submitted_at = NULL WHERE id = ${next.id}`).then(() => null, (e: unknown) => e);
    expect(pgErrorCode(reopen)).toBe("23001");
    // Nor is a final count's line moved to an open one.
    const open = await created(await post("/stock-takes", storekeeper, { storeId: main }));
    const moved = await db.execute(sql`UPDATE stock_take_lines SET stock_take_id = ${open.id} WHERE stock_take_id = ${next.id}`).then(() => null, (e: unknown) => e);
    expect(pgErrorCode(moved)).toBe("23001");
  });

  it("is cancelled after its store is retired, and never without a reason", async () => {
    // The main store holds nothing, so it can be retired with its count open: that count is then cancelled, not submitted.
    const take = await created(await post("/stock-takes", storekeeper, { storeId: main }));
    expect((await call("PATCH", `/stores/${main}`, h.facility.id, h.admin, { isActive: false })).status).toBe(200);
    expect(await refusal(await post(`/stock-takes/${take.id}/submit`, storekeeper))).toBe("store_retired");
    expect((await (await post(`/stock-takes/${take.id}/cancel`, storekeeper, { reason: "Store closed" })).json()).status).toBe("cancelled");

    const open = await created(await post("/stock-takes", storekeeper, { storeId: pharmacy }));
    const bare = await db.execute(sql`UPDATE stock_takes SET status = 'cancelled', cancelled_by = opened_by, cancelled_at = now() WHERE id = ${open.id}`).then(() => null, (e: unknown) => e);
    expect(pgErrorCode(bare)).toBe("23514");
  });

  it("keeps a line written directly waiting while its count is submitted, then refuses it", async () => {
    const take = await created(await post("/stock-takes", storekeeper, { storeId: pharmacy }));
    await count(take.id, [{ batchId: p1, quantity: 2990 }]);

    let write: Promise<unknown> | undefined;
    await db.transaction(async (submitting) => {
      await submitting.execute(sql`UPDATE stock_takes SET status = 'submitted', submitted_by = opened_by, submitted_at = now() WHERE id = ${take.id}`);
      write = db.execute(sql`UPDATE stock_take_lines SET counted_quantity = 2980 WHERE stock_take_id = ${take.id}`).then(() => null, (e: unknown) => e);
      expect(await waitForBlockedBackend(await backendPid(submitting))).toBe(true);
    });

    expect(pgErrorCode(await write)).toBe("23001");
  });

  it("has its correction approved by someone who neither submitted nor counted it", async () => {
    const take = await created(await post("/stock-takes", storekeeper, { storeId: pharmacy }));
    // The pharmacist counts; the storekeeper submits.
    await count(take.id, [{ batchId: p1, quantity: 2990 }], pharmacist);
    const submitted = await (await post(`/stock-takes/${take.id}/submit`, storekeeper)).json();

    expect(await refusal(await post(`/stock-adjustments/${submitted.adjustmentId}/approve`, pharmacist), 403)).toBe("counted_it");
    expect((await post(`/stock-adjustments/${submitted.adjustmentId}/approve`, h.finance)).status).toBe(200);
    expect(await shelf()).toBe(2990);
  });

  it("is read by a nurse only when it is of a ward's store", async () => {
    const wardStore = (await created(await post("/stores", h.admin, { name: "Ward 1", kind: "ward" }))).id;
    const nurse = await staff(["ward_nurse"]);
    const ofWard = await created(await post("/stock-takes", nurse, { storeId: wardStore }));
    const ofPharmacy = await created(await post("/stock-takes", storekeeper, { storeId: pharmacy }));
    await count(ofPharmacy.id, [{ batchId: p1, quantity: 3000 }]);
    await post(`/stock-takes/${ofPharmacy.id}/submit`, storekeeper);
    const listed = async (who: StaffMember, query = "") => (await (await call("GET", `/stock-takes${query}`, h.facility.id, who)).json()).takes.map((t: { id: string }) => t.id);

    // The pharmacy's count shows what it holds, which a nurse does not otherwise read.
    expect(await listed(nurse)).toEqual([ofWard.id]);
    expect(await listed(nurse, `?storeId=${pharmacy}`)).toEqual([]);
    expect((await call("GET", `/stock-takes/${ofPharmacy.id}`, h.facility.id, nurse)).status).toBe(404);
    expect((await call("GET", `/stock-takes/${ofWard.id}`, h.facility.id, nurse)).status).toBe(200);
    expect((await listed(h.auditor)).sort()).toEqual([ofWard.id, ofPharmacy.id].sort());
    expect((await call("GET", `/stock-takes/${ofPharmacy.id}`, h.facility.id, h.auditor)).status).toBe(200);
  });

  it("lists on its sheet a batch that the last correction, approved as the count was opened, brought into the store", async () => {
    // Five of main store's batch turn up on the pharmacy's shelf: none in its ledger until the correction is approved.
    const other = await created(await post("/goods-received", storekeeper, { storeId: main, supplier: "MEDS", lines: [{ stockItemId: paracetamol, batchNumber: "M1", expiresOn: inDays(200), units: 50, totalCostCents: 5000 }] }));
    const found = other.items[0].batchId as string;
    const first = await created(await post("/stock-takes", storekeeper, { storeId: pharmacy }));
    await count(first.id, [{ batchId: p1, quantity: 3000 }, { batchId: found, quantity: 5 }]);
    const submitted = await (await post(`/stock-takes/${first.id}/submit`, storekeeper)).json();

    let opening: Promise<Response> | undefined;
    await db.transaction(async (holder) => {
      // The next count waits for its number, and the correction is approved meanwhile.
      await holder.execute(sql`SELECT 1 FROM number_series_counters c JOIN number_series s ON s.id = c.series_id WHERE s.facility_id = ${h.facility.id} AND s.kind = 'stock_take' FOR UPDATE OF c`);
      opening = post("/stock-takes", storekeeper, { storeId: pharmacy });
      expect(await waitForBlockedBackend(await backendPid(holder))).toBe(true);
      expect((await post(`/stock-adjustments/${submitted.adjustmentId}/approve`, h.finance)).status).toBe(200);
    });

    const second = await created(await opening!);
    expect(second.lines.map((l: { batchId: string }) => l.batchId).sort()).toEqual([p1, found].sort());
  });

  it("never keeps a count without what was expected beside it", async () => {
    const take = await created(await post("/stock-takes", storekeeper, { storeId: pharmacy }));
    await count(take.id, [{ batchId: p1, quantity: 2990 }]);

    const bare = await db.execute(sql`UPDATE stock_take_lines SET expected_quantity = NULL WHERE stock_take_id = ${take.id}`).then(() => null, (e: unknown) => e);

    expect(pgErrorCode(bare)).toBe("23514");
  });

  it("is not opened again while the store's last count is being submitted with a correction", async () => {
    const take = await created(await post("/stock-takes", storekeeper, { storeId: pharmacy }));
    await count(take.id, [{ batchId: p1, quantity: 2990 }]);
    let release!: () => void;
    const mayCommit = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let holderPid = 0;
    const submitting = runAsFacility(h.facility.id, async (tx) => {
      try {
        await submitStockTake(tx, h.facility.id, take.id, { ...storekeeper.actor, roles: ["storekeeper"], licenceProfession: null });
        holderPid = await backendPid(tx);
      }
      finally {
        ready();
        await mayCommit;
      }
    });
    await started;

    // It waits for the submission (one open count per store), then sees the correction that came with it.
    const reopened = post("/stock-takes", storekeeper, { storeId: pharmacy });
    try {
      expect(await waitForBlockedBackend(holderPid)).toBe(true);
    }
    finally {
      release();
      await Promise.allSettled([submitting, reopened]);
    }

    expect(await refusal(await reopened)).toBe("correction_pending");
  });
});
