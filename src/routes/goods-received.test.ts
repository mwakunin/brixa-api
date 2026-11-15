import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { Hospital, StaffMember } from "@/test/hospital";

import db, { pool } from "@/db";
import { auditLog, goodsReceived } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import { addDays, businessDate } from "@/lib/dates";
import { pgConstraintName, pgErrorCode } from "@/lib/db-errors";
import { loadDrugCatalogue } from "@/lib/drug-catalogue-load";
import { receiveGoods } from "@/lib/goods-received";
import { updateStockItem } from "@/lib/stock-items";
import { addMembership, backendPid, resetDb, signedInUser, waitForBlockedBackend } from "@/test/helpers";
import { call, hospital } from "@/test/hospital";

/** P4 slice 1b: goods received, batches, the stock ledger and the stock view. */

const SAMPLE = path.resolve(import.meta.dirname, "../test/fixtures/drug-catalogue-sample.csv");

let h: Hospital;
let storekeeper: StaffMember;
let pharmTech: StaffMember;
let pharmacy: string;
let paracetamol: string;
let gloves: string;

async function staff(roles: Parameters<typeof addMembership>[2]): Promise<StaffMember> {
  const user = await signedInUser();
  const membership = await addMembership(user.id, h.facility.id, roles);
  return { ...user, actor: { userId: user.id, membershipId: membership.id } };
}

async function created(res: Response): Promise<{ id: string }> {
  expect(res.status).toBe(201);
  return res.json();
}

const inDays = (days: number) => addDays(businessDate(), days);

beforeEach(async () => {
  await resetDb();
  await loadDrugCatalogue(await readFile(SAMPLE, "utf8"));
  h = await hospital();
  storekeeper = await staff(["storekeeper"]);
  pharmTech = await staff(["pharm_tech"]);
  pharmacy = (await created(await call("POST", "/stores", h.facility.id, h.admin, { name: "Pharmacy", kind: "pharmacy" }))).id;
  paracetamol = (await created(await call("POST", "/stock-items", h.facility.id, h.admin, { billableItemId: h.items.tablet, drugCode: "PCM-500-TAB", baseUnit: "tablet", packSize: 1000 }))).id;
  const glovesItem = (await created(await call("POST", "/billable-items", h.facility.id, h.admin, { code: "GLV-M", name: "Gloves, medium", category: "consumable" }))).id;
  gloves = (await created(await call("POST", "/stock-items", h.facility.id, h.admin, { billableItemId: glovesItem, baseUnit: "pair", packSize: 50 }))).id;
});

const receive = (body: Record<string, unknown>, who: StaffMember = storekeeper) => call("POST", "/goods-received", h.facility.id, who, body);

function delivery(lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  return { storeId: pharmacy, supplier: "Mission for Essential Drugs and Supplies", supplierReference: "DN-4471", lines, ...extra };
}

const pcmLine = (extra: Record<string, unknown> = {}) => ({ stockItemId: paracetamol, batchNumber: "PC2611A", expiresOn: inDays(400), packs: 3, totalCostCents: 450_000, ...extra });

async function stockOf(store = pharmacy, who: StaffMember = storekeeper) {
  const res = await call("GET", `/stores/${store}/stock`, h.facility.id, who);
  expect(res.status).toBe(200);
  return (await res.json()).items;
}

describe("receiving goods", () => {
  it("numbers the note, makes each line a batch at its own cost, and puts it on the store's shelf", async () => {
    const res = await receive(delivery([
      pcmLine(),
      pcmLine({ batchNumber: "PC2611B", expiresOn: inDays(30), packs: undefined, units: 250, totalCostCents: 30_000 }),
      { stockItemId: gloves, packs: 2, totalCostCents: 0 },
    ]));

    expect(res.status).toBe(201);
    const note = await res.json();
    expect(note).toMatchObject({
      number: `GRN-${businessDate().slice(0, 4)}-000001`,
      storeName: "Pharmacy",
      supplier: "Mission for Essential Drugs and Supplies",
      supplierReference: "DN-4471",
      receivedOn: businessDate(),
      lines: 3,
      totalCostCents: 480_000,
    });
    expect(note.items.map((i: Record<string, unknown>) => [i.line, i.code, i.batchNumber, i.quantity, i.packSize, i.totalCostCents])).toEqual([
      [1, "PCM-500", "PC2611A", 3000, 1000, 450_000],
      [2, "PCM-500", "PC2611B", 250, 1000, 30_000],
      // Donated, with no batch number or expiry: a consumable may have neither.
      [3, "GLV-M", null, 100, 50, 0],
    ]);
    // Taken, but flagged: it expires inside 90 days.
    expect(note.warnings).toEqual([{ line: 2, code: "expires_soon", expiresOn: inDays(30) }]);

    const items = await stockOf();
    expect(items).toEqual([
      expect.objectContaining({ code: "GLV-M", onHand: 100, valueCents: 0, reorderLevel: null }),
      expect.objectContaining({
        code: "PCM-500",
        onHand: 3250,
        valueCents: 480_000,
        // Earliest expiry first: the order they are used in.
        batches: [
          expect.objectContaining({ batchNumber: "PC2611B", onHand: 250, expired: false }),
          expect.objectContaining({ batchNumber: "PC2611A", onHand: 3000 }),
        ],
      }),
    ]);
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "goods.received"));
    expect(entry).toMatchObject({ actorId: storekeeper.id, entityId: note.id, detail: { lines: 3, totalCostCents: 480_000 } });
  });

  it("refuses the whole note over one bad line, naming it, and keeps nothing of it", async () => {
    const refusal = async (lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) => {
      const res = await receive(delivery(lines, extra));
      expect(res.status).toBe(409);
      return res.json();
    };
    const retiredItem = (await created(await call("POST", "/billable-items", h.facility.id, h.admin, { code: "IBU-400", name: "Ibuprofen", category: "drug" }))).id;
    const retired = (await created(await call("POST", "/stock-items", h.facility.id, h.admin, { billableItemId: retiredItem, drugCode: "IBU-400-TAB", baseUnit: "tablet", packSize: 100 }))).id;
    await call("PATCH", `/stock-items/${retired}`, h.facility.id, h.admin, { isActive: false });

    expect(await refusal([pcmLine(), pcmLine({ batchNumber: undefined })])).toMatchObject({ code: "batch_number_needed", line: 2 });
    expect(await refusal([pcmLine({ expiresOn: undefined })])).toMatchObject({ code: "expiry_needed", line: 1 });
    expect(await refusal([pcmLine({ expiresOn: inDays(-1) })])).toMatchObject({ code: "already_expired", line: 1 });
    expect(await refusal([pcmLine({ stockItemId: randomUUID() })])).toMatchObject({ code: "item_not_found", line: 1 });
    expect(await refusal([pcmLine({ stockItemId: retired })])).toMatchObject({ code: "item_retired", line: 1 });
    expect(await refusal([pcmLine({ packs: 100_001 })])).toMatchObject({ code: "quantity_too_large", line: 1 });
    expect((await refusal([pcmLine()], { receivedOn: inDays(1) })).code).toBe("received_in_future");
    expect((await refusal([pcmLine()], { storeId: randomUUID() })).code).toBe("store_not_found");

    expect(await db.select().from(goodsReceived)).toEqual([]);
    // The number a refused note would have taken is still the next one.
    const res = await receive(delivery([pcmLine()]));
    expect((await res.json()).number).toMatch(/-000001$/);
  });

  it("takes a quantity in packs or in units, one of them, and a cost in whole cents", async () => {
    expect((await receive(delivery([pcmLine({ units: 10 })]))).status).toBe(422);
    expect((await receive(delivery([pcmLine({ packs: undefined })]))).status).toBe(422);
    expect((await receive(delivery([pcmLine({ packs: 0 })]))).status).toBe(422);
    expect((await receive(delivery([pcmLine({ totalCostCents: -1 })]))).status).toBe(422);
    expect((await receive(delivery([pcmLine({ totalCostCents: 10.5 })]))).status).toBe(422);
    expect((await receive(delivery([]))).status).toBe(422);
    expect((await receive(delivery([pcmLine()], { supplier: " " }))).status).toBe(422);
  });

  it("takes a delivery that arrived on an earlier day", async () => {
    const res = await receive(delivery([pcmLine()], { receivedOn: inDays(-3) }));

    expect((await res.json()).receivedOn).toBe(inDays(-3));
  });

  it("is done by storekeepers, pharmacists and pharmacy technicians, and read by those who account for stock", async () => {
    const pharmacist = await staff(["pharmacist"]);
    for (const who of [storekeeper, pharmacist, pharmTech])
      expect((await receive(delivery([pcmLine()]), who)).status).toBe(201);
    for (const who of [h.nurse, h.cashier, h.admin])
      expect((await receive(delivery([pcmLine()]), who)).status).toBe(403);

    for (const who of [h.finance, h.auditor, h.admin, pharmTech]) {
      expect((await call("GET", "/goods-received", h.facility.id, who)).status).toBe(200);
      expect((await call("GET", `/stores/${pharmacy}/stock`, h.facility.id, who)).status).toBe(200);
    }
    expect((await call("GET", "/goods-received", h.facility.id, h.cashier)).status).toBe(403);
    expect((await call("GET", `/stores/${pharmacy}/stock`, h.facility.id, h.nurse)).status).toBe(403);
  });

  it("lists notes newest first, one store's if asked", async () => {
    const main = (await created(await call("POST", "/stores", h.facility.id, h.admin, { name: "Main store", kind: "main" }))).id;
    await receive(delivery([pcmLine()]));
    await receive(delivery([pcmLine()], { storeId: main }));

    const all = (await (await call("GET", "/goods-received", h.facility.id, h.finance)).json()).notes;
    expect(all.map((n: { storeName: string }) => n.storeName)).toEqual(["Main store", "Pharmacy"]);
    const one = (await (await call("GET", `/goods-received?storeId=${pharmacy}`, h.facility.id, h.finance)).json()).notes;
    expect(one).toEqual([expect.objectContaining({ storeName: "Pharmacy", lines: 1, receivedByName: "Test User" })]);
    expect((await call("GET", `/goods-received/${randomUUID()}`, h.facility.id, h.finance)).status).toBe(404);
  });
});

describe("ids however they are spelled", () => {
  it("receive, reverse and set levels by an id in capitals as by its own spelling", async () => {
    const res = await receive(delivery([pcmLine({ stockItemId: paracetamol.toUpperCase() })]));
    expect(res.status).toBe(201);
    const batchId: string = (await res.json()).items[0].batchId;

    const reverse = (id: string) => call("POST", `/stock-batches/${id}/reverse`, h.facility.id, storekeeper, { reason: "Wrong item" });
    expect((await reverse(batchId.toUpperCase())).status).toBe(200);
    expect((await (await reverse(batchId)).json()).code).toBe("already_reversed");

    const level = (stockItemId: string, value: number) =>
      call("PUT", `/stores/${pharmacy}/reorder-levels`, h.facility.id, storekeeper, { levels: [{ stockItemId, level: value }] });
    await level(paracetamol, 100);
    await level(paracetamol.toUpperCase(), 200);
    const entries = await db.select().from(auditLog).where(eq(auditLog.action, "reorder_levels.set"));
    expect(entries.map(e => e.detail)).toContainEqual({ changes: [{ stockItemId: paracetamol, before: 100, after: 200 }] });
  });
});

describe("the stock view", () => {
  it("shows an item with a reorder level and nothing on hand, and marks a batch past its expiry", async () => {
    await call("PUT", `/stores/${pharmacy}/reorder-levels`, h.facility.id, h.admin, { levels: [{ stockItemId: gloves, level: 200 }] });
    // Received a month ago, in date then; its last day was yesterday.
    await runAsFacility(h.facility.id, tx => receiveGoods(tx, h.facility.id, { storeId: pharmacy, supplier: "KEMSA", lines: [pcmLine({ expiresOn: inDays(-1) })] }, storekeeper.actor, inDays(-30)));

    const items = await stockOf();

    expect(items).toEqual([
      expect.objectContaining({ code: "GLV-M", onHand: 0, valueCents: 0, reorderLevel: 200, batches: [] }),
      expect.objectContaining({ code: "PCM-500", onHand: 3000, batches: [expect.objectContaining({ expired: true, expiresOn: inDays(-1) })] }),
    ]);
    expect((await call("GET", `/stores/${randomUUID()}/stock`, h.facility.id, storekeeper)).status).toBe(404);
  });
});

describe("reversing a line", () => {
  it("takes the whole line back off the shelf, with a reason, once", async () => {
    const note = await (await receive(delivery([pcmLine(), { stockItemId: gloves, units: 40, totalCostCents: 2000 }]))).json();
    const batchId = note.items[0].batchId;
    const reverse = (body: Record<string, unknown>, who: StaffMember = pharmTech, id = batchId) =>
      call("POST", `/stock-batches/${id}/reverse`, h.facility.id, who, body);

    expect((await reverse({})).status).toBe(422);
    expect((await reverse({ reason: "Typed 3 packs; 2 came" }, h.nurse)).status).toBe(403);
    const res = await reverse({ reason: "Typed 3 packs; 2 came" });

    expect(res.status).toBe(200);
    expect((await res.json()).items[0].reversal).toMatchObject({ reason: "Typed 3 packs; 2 came" });
    expect((await stockOf()).map((i: { code: string; onHand: number }) => [i.code, i.onHand])).toEqual([["GLV-M", 40]]);
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "stock_batch.reversed"));
    expect(entry).toMatchObject({ actorId: pharmTech.id, entityId: note.id, detail: { line: 1, quantity: 3000, reason: "Typed 3 packs; 2 came" } });

    expect((await (await reverse({ reason: "Again" })).json()).code).toBe("already_reversed");
    expect((await reverse({ reason: "Nope" }, pharmTech, randomUUID())).status).toBe(404);
  });
});

describe("retiring what holds stock", () => {
  it("refuses a store or an item still holding stock, and allows it once none is left", async () => {
    const note = await (await receive(delivery([pcmLine()]))).json();

    const store = await call("PATCH", `/stores/${pharmacy}`, h.facility.id, h.admin, { isActive: false });
    expect(store.status).toBe(409);
    expect((await store.json()).code).toBe("holds_stock");
    const item = await call("PATCH", `/stock-items/${paracetamol}`, h.facility.id, h.admin, { isActive: false });
    expect(item.status).toBe(409);
    expect((await item.json()).code).toBe("holds_stock");

    await call("POST", `/stock-batches/${note.items[0].batchId}/reverse`, h.facility.id, storekeeper, { reason: "Wrong store" });
    expect((await call("PATCH", `/stock-items/${paracetamol}`, h.facility.id, h.admin, { isActive: false })).status).toBe(200);
    expect((await call("PATCH", `/stores/${pharmacy}`, h.facility.id, h.admin, { isActive: false })).status).toBe(200);
    expect((await (await receive(delivery([{ stockItemId: gloves, units: 1, totalCostCents: 0 }]))).json()).code).toBe("store_retired");
  });

  it("makes a retirement wait for a delivery of the item still going in, then refuses it", async () => {
    let release!: () => void;
    const mayCommit = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let holderPid = 0;
    const delivering = runAsFacility(h.facility.id, async (tx) => {
      try {
        await receiveGoods(tx, h.facility.id, { storeId: pharmacy, supplier: "KEMSA", lines: [pcmLine()] }, storekeeper.actor);
        holderPid = await backendPid(tx);
      }
      finally {
        ready();
        await mayCommit;
      }
    });
    await started;

    const retiring = runAsFacility(h.facility.id, tx => updateStockItem(tx, h.facility.id, paracetamol, { isActive: false }, h.admin.actor));
    try {
      expect(await waitForBlockedBackend(holderPid)).toBe(true);
    }
    finally {
      release();
      await Promise.allSettled([delivering, retiring]);
    }

    await expect(retiring).rejects.toMatchObject({ code: "holds_stock" });
  });
});

describe("the stock ledger", () => {
  it("is append-only for every role, and never below zero whatever writes it", async () => {
    const note = await (await receive(delivery([pcmLine()]))).json();
    const batchId = note.items[0].batchId;

    const update = await runAsFacility(h.facility.id, tx => tx.execute(sql`UPDATE stock_movements SET quantity = 1 WHERE batch_id = ${batchId}`))
      .then(() => null, (e: unknown) => e);
    expect(pgErrorCode(update)).toBe("42501");
    const asOwner = await db.execute(sql`DELETE FROM stock_movements WHERE batch_id = ${batchId}`).then(() => null, (e: unknown) => e);
    expect(pgErrorCode(asOwner)).toBe("23001");

    const below = await pool.query(
      `INSERT INTO stock_movements (facility_id, store_id, batch_id, kind, quantity, goods_received_id, reason, recorded_by)
       VALUES ($1, $2, $3, 'receipt_reversed', -3001, $4, 'More than came', $5)`,
      [h.facility.id, pharmacy, batchId, note.id, storekeeper.actor.membershipId],
    ).then(() => null, (e: unknown) => e);
    expect(pgConstraintName(below)).toBe("stock_movements_never_negative");

    // Nor can a note or its batches be edited: not by a request, nor by the owner.
    for (const statement of [sql`UPDATE goods_received SET supplier = 'X'`, sql`UPDATE stock_batches SET total_cost_cents = 1`]) {
      const err = await runAsFacility(h.facility.id, tx => tx.execute(statement)).then(() => null, (e: unknown) => e);
      expect(pgErrorCode(err)).toBe("42501");
    }
    for (const statement of [
      sql`UPDATE goods_received SET supplier = 'X'`,
      sql`DELETE FROM goods_received`,
      sql`UPDATE stock_batches SET total_cost_cents = 1`,
      sql`DELETE FROM stock_batches`,
    ]) {
      const err = await db.execute(statement).then(() => null, (e: unknown) => e);
      expect(pgErrorCode(err), String(statement.queryChunks[0])).toBe("23001");
    }
  });
});
