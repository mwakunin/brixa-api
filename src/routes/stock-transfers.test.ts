import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { Hospital, StaffMember } from "@/test/hospital";

import db from "@/db";
import { auditLog } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import { addDays, businessDate } from "@/lib/dates";
import { pgErrorCode } from "@/lib/db-errors";
import { loadDrugCatalogue } from "@/lib/drug-catalogue-load";
import { receiveGoods } from "@/lib/goods-received";
import { transferShown } from "@/lib/transfer-views";
import { receiveTransfer, sendDirect } from "@/lib/transfers";
import { addMembership, backendPid, resetDb, signedInUser, waitForBlockedBackend } from "@/test/helpers";
import { call, hospital } from "@/test/hospital";

/** P4 slice 2: transfers between stores. */

const SAMPLE = path.resolve(import.meta.dirname, "../test/fixtures/drug-catalogue-sample.csv");

let h: Hospital;
let storekeeper: StaffMember;
let pharmacist: StaffMember;
let wardNurse: StaffMember;
let main: string;
let pharmacy: string;
let maternity: string;
let paracetamol: string;
/** In the main store: 1,000 expiring in 100 days, and 3,000 in 400. */
let soon: string;
let later: string;

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

const actorOf = (who: StaffMember, roles: Parameters<typeof addMembership>[2]) => ({ ...who.actor, roles });

beforeEach(async () => {
  await resetDb();
  await loadDrugCatalogue(await readFile(SAMPLE, "utf8"));
  h = await hospital();
  storekeeper = await staff(["storekeeper"]);
  pharmacist = await staff(["pharmacist"]);
  wardNurse = await staff(["ward_nurse"]);
  const store = async (name: string, kind: string) => (await created(await call("POST", "/stores", h.facility.id, h.admin, { name, kind }))).id;
  main = await store("Main store", "main");
  pharmacy = await store("Pharmacy", "pharmacy");
  maternity = await store("Maternity", "ward");
  paracetamol = (await created(await call("POST", "/stock-items", h.facility.id, h.admin, { billableItemId: h.items.tablet, drugCode: "PCM-500-TAB", baseUnit: "tablet", packSize: 1000 }))).id;
  const note = await created(await call("POST", "/goods-received", h.facility.id, storekeeper, {
    storeId: main,
    supplier: "MEDS",
    lines: [
      { stockItemId: paracetamol, batchNumber: "LATER", expiresOn: inDays(400), packs: 3, totalCostCents: 300_000 },
      { stockItemId: paracetamol, batchNumber: "SOON", expiresOn: inDays(100), packs: 1, totalCostCents: 100_000 },
    ],
  }));
  [later, soon] = note.items.map((i: { batchId: string }) => i.batchId);
});

const post = (url: string, who: StaffMember, body: unknown = {}) => call("POST", url, h.facility.id, who, body);
const request = (body: Record<string, unknown>, who: StaffMember = pharmacist) => post("/stock-transfers", who, body);
function ask(quantity: number, to = pharmacy, who: StaffMember = pharmacist) {
  return request({ fromStoreId: main, toStoreId: to, items: [{ stockItemId: paracetamol, quantity }] }, who);
}

async function onHand(store: string): Promise<number> {
  const items = (await (await call("GET", `/stores/${store}/stock`, h.facility.id, storekeeper)).json()).items;
  return items.reduce((sum: number, i: { onHand: number }) => sum + i.onHand, 0);
}

async function refusal(res: Response, status = 409): Promise<string> {
  expect(res.status).toBe(status);
  return (await res.json()).code;
}

describe("a transfer", () => {
  it("is asked for, sent earliest expiry first, and received into the other store", async () => {
    const asked = await created(await ask(1500));
    expect(asked).toMatchObject({ number: `TRF-${businessDate().slice(0, 4)}-000001`, status: "requested", fromStore: { name: "Main store" }, toStore: { name: "Pharmacy" } });
    expect(asked.items).toEqual([expect.objectContaining({ code: "PCM-500", quantityRequested: 1500 })]);

    const sent = await (await post(`/stock-transfers/${asked.id}/send`, storekeeper, { lines: [{ stockItemId: paracetamol, quantity: 1500 }] })).json();
    expect(sent.status).toBe("sent");
    expect(sent.batches.map((b: Record<string, unknown>) => [b.batchNumber, b.quantitySent, b.quantityReceived])).toEqual([["SOON", 1000, null], ["LATER", 500, null]]);
    // On its way: out of the main store, not yet in the pharmacy.
    expect([await onHand(main), await onHand(pharmacy)]).toEqual([2500, 0]);

    const received = await (await post(`/stock-transfers/${asked.id}/receive`, pharmacist)).json();
    expect(received).toMatchObject({ status: "received", awaitingAcceptance: false, shortfallReason: null });
    expect(received.batches.map((b: { quantityReceived: number }) => b.quantityReceived)).toEqual([1000, 500]);
    expect([await onHand(main), await onHand(pharmacy)]).toEqual([2500, 1500]);
    expect(received.requested.byName).toBe("Test User");

    const actions = (await db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, asked.id))).map(a => a.action);
    expect(actions).toEqual(["stock_transfer.requested", "stock_transfer.sent", "stock_transfer.received"]);
  });

  it("is sent without a request, and received into a ward's store by its nurse", async () => {
    const sent = await created(await post("/stock-transfers/send", storekeeper, { fromStoreId: main, toStoreId: maternity, lines: [{ stockItemId: paracetamol, quantity: 200 }] }));
    expect(sent).toMatchObject({ status: "sent", requested: null });

    expect((await post(`/stock-transfers/${sent.id}/receive`, wardNurse)).status).toBe(200);
    expect(await onHand(maternity)).toBe(200);
  });

  it("is asked for by a nurse only for a ward's store, and sent only by the stores' staff", async () => {
    expect(await refusal(await ask(10, pharmacy, wardNurse), 403)).toBe("ward_store_only");
    const asked = await created(await ask(10, maternity, wardNurse));
    expect((await post(`/stock-transfers/${asked.id}/send`, wardNurse, { lines: [{ stockItemId: paracetamol, quantity: 10 }] })).status).toBe(403);
    expect((await ask(10, pharmacy, h.cashier)).status).toBe(403);

    // Nor does a nurse receive into the pharmacy.
    const toPharmacy = await created(await post("/stock-transfers/send", storekeeper, { fromStoreId: main, toStoreId: pharmacy, lines: [{ stockItemId: paracetamol, quantity: 10 }] }));
    expect(await refusal(await post(`/stock-transfers/${toPharmacy.id}/receive`, wardNurse), 403)).toBe("ward_store_only");
  });

  it("is received by someone other than its sender", async () => {
    const sent = await created(await post("/stock-transfers/send", storekeeper, { fromStoreId: main, toStoreId: pharmacy, lines: [{ stockItemId: paracetamol, quantity: 10 }] }));
    // On its way, its stores are as sent: not even the owner points it elsewhere.
    const moved = await db.execute(sql`UPDATE stock_transfers SET to_store_id = ${maternity} WHERE id = ${sent.id}`).then(() => null, (e: unknown) => e);
    expect(pgErrorCode(moved)).toBe("23001");

    expect(await refusal(await post(`/stock-transfers/${sent.id}/receive`, storekeeper))).toBe("same_person");
  });

  it("refuses two stores that are one, a store that is not, and an item given twice", async () => {
    expect(await refusal(await request({ fromStoreId: main, toStoreId: main.toUpperCase(), items: [{ stockItemId: paracetamol, quantity: 1 }] }))).toBe("same_store");
    expect(await refusal(await request({ fromStoreId: main, toStoreId: randomUUID(), items: [{ stockItemId: paracetamol, quantity: 1 }] }))).toBe("store_not_found");
    expect((await request({ fromStoreId: main, toStoreId: pharmacy, items: [{ stockItemId: paracetamol, quantity: 1 }, { stockItemId: paracetamol.toUpperCase(), quantity: 2 }] })).status).toBe(422);
  });
});

describe("sending", () => {
  const direct = (lines: unknown[]) => post("/stock-transfers/send", storekeeper, { fromStoreId: main, toStoreId: pharmacy, lines });

  it("takes the batches named, never an expired one, and no more than the store holds", async () => {
    const named = await created(await direct([{ stockItemId: paracetamol, batches: [{ batchId: later, quantity: 100 }] }]));
    expect(named.batches).toEqual([expect.objectContaining({ batchNumber: "LATER", quantitySent: 100 })]);

    await runAsFacility(h.facility.id, tx => receiveGoods(tx, h.facility.id, { storeId: main, supplier: "MEDS", lines: [{ stockItemId: paracetamol, batchNumber: "OLD", expiresOn: inDays(-1), units: 50, totalCostCents: 5000 }] }, storekeeper.actor, inDays(-30)));
    const old = (await (await call("GET", `/stores/${main}/stock`, h.facility.id, storekeeper)).json()).items[0].batches[0];
    expect(old).toMatchObject({ batchNumber: "OLD", expired: true });

    expect(await refusal(await direct([{ stockItemId: paracetamol, batches: [{ batchId: old.batchId, quantity: 1 }] }]))).toBe("batch_expired");
    // Earliest expiry first passes the expired batch by.
    const firstInDate = await created(await direct([{ stockItemId: paracetamol, quantity: 10 }]));
    expect(firstInDate.batches).toEqual([expect.objectContaining({ batchNumber: "SOON" })]);
    const tooMuch = await direct([{ stockItemId: paracetamol, quantity: 10 }, { stockItemId: paracetamol, quantity: 4000 }]);
    expect(await tooMuch.json()).toMatchObject({ code: "not_enough_stock", line: 2 });
    expect(await refusal(await direct([{ stockItemId: paracetamol, batches: [{ batchId: soon, quantity: 991 }] }]))).toBe("not_enough_stock");
    expect(await refusal(await direct([{ stockItemId: paracetamol, batches: [{ batchId: randomUUID(), quantity: 1 }] }]))).toBe("batch_not_found");
    expect((await direct([{ stockItemId: paracetamol, quantity: 1, batches: [{ batchId: soon, quantity: 1 }] }])).status).toBe(422);
  });

  it("sends only what was asked for, never more of it nor another item", async () => {
    const asked = await created(await ask(10));
    const send = (lines: unknown[]) => post(`/stock-transfers/${asked.id}/send`, storekeeper, { lines });
    const amoxilItem = (await created(await call("POST", "/billable-items", h.facility.id, h.admin, { code: "AMX-500", name: "Amoxicillin", category: "drug" }))).id;
    const amoxil = (await created(await call("POST", "/stock-items", h.facility.id, h.admin, { billableItemId: amoxilItem, drugCode: "AMX-500-CAP", baseUnit: "capsule", packSize: 100 }))).id;

    expect(await refusal(await send([{ stockItemId: paracetamol, quantity: 6 }, { stockItemId: paracetamol, batches: [{ batchId: later, quantity: 5 }] }]))).toBe("more_than_requested");
    expect(await refusal(await send([{ stockItemId: amoxil, quantity: 1 }]))).toBe("not_requested");
    expect((await send([{ stockItemId: paracetamol, quantity: 10 }])).status).toBe(200);
  });

  it("may send less than was asked for, with no back-order", async () => {
    const asked = await created(await ask(2000));

    const sent = await (await post(`/stock-transfers/${asked.id}/send`, storekeeper, { lines: [{ stockItemId: paracetamol, quantity: 500 }] })).json();

    expect(sent.items[0].quantityRequested).toBe(2000);
    expect(sent.batches.map((b: { quantitySent: number }) => b.quantitySent)).toEqual([500]);
    expect(await refusal(await post(`/stock-transfers/${asked.id}/send`, storekeeper, { lines: [{ stockItemId: paracetamol, quantity: 1 }] }))).toBe("not_open");
  });

  it("queues two sends from one batch, so the second sees what the first took", async () => {
    let release!: () => void;
    const mayCommit = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let holderPid = 0;
    const lines = [{ stockItemId: paracetamol, batches: [{ batchId: soon, quantity: 1000 }] }];
    const first = runAsFacility(h.facility.id, async (tx) => {
      try {
        await sendDirect(tx, h.facility.id, { fromStoreId: main, toStoreId: pharmacy, lines }, actorOf(storekeeper, ["storekeeper"]));
        holderPid = await backendPid(tx);
      }
      finally {
        ready();
        await mayCommit;
      }
    });
    await started;

    const second = runAsFacility(h.facility.id, tx => sendDirect(tx, h.facility.id, { fromStoreId: main, toStoreId: maternity, lines }, actorOf(storekeeper, ["storekeeper"])));
    try {
      expect(await waitForBlockedBackend(holderPid)).toBe(true);
    }
    finally {
      release();
      await Promise.allSettled([first, second]);
    }

    await expect(second).rejects.toMatchObject({ code: "not_enough_stock" });
  });

  it("is shown as one moment: a read waits for a receipt being written, then shows it whole", async () => {
    const sent = await created(await post("/stock-transfers/send", storekeeper, { fromStoreId: main, toStoreId: pharmacy, lines: [{ stockItemId: paracetamol, quantity: 100 }] }));
    let release!: () => void;
    const mayCommit = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let holderPid = 0;
    const receipt = runAsFacility(h.facility.id, async (tx) => {
      try {
        await receiveTransfer(tx, h.facility.id, sent.id, {}, actorOf(pharmacist, ["pharmacist"]));
        holderPid = await backendPid(tx);
      }
      finally {
        ready();
        await mayCommit;
      }
    });
    await started;

    const shown = runAsFacility(h.facility.id, tx => transferShown(tx, sent.id));
    try {
      expect(await waitForBlockedBackend(holderPid)).toBe(true);
    }
    finally {
      release();
      await Promise.allSettled([receipt, shown]);
    }

    expect(await shown).toMatchObject({ status: "received", batches: [expect.objectContaining({ quantitySent: 100, quantityReceived: 100 })] });
  });
});

describe("a shortfall", () => {
  let transferId: string;

  beforeEach(async () => {
    transferId = (await created(await post("/stock-transfers/send", storekeeper, { fromStoreId: main, toStoreId: pharmacy, lines: [{ stockItemId: paracetamol, quantity: 1500 }] }))).id;
  });

  const receive = (body: Record<string, unknown>, who: StaffMember = pharmacist) => post(`/stock-transfers/${transferId}/receive`, who, body);

  it("needs its reason, and waits for a second person, never its receiver, to accept the loss", async () => {
    expect(await refusal(await receive({ received: [{ batchId: soon, quantity: 990 }] }))).toBe("shortfall_reason_needed");
    expect(await refusal(await receive({ received: [{ batchId: soon, quantity: 1001 }] }))).toBe("more_than_sent");
    expect(await refusal(await receive({ received: [{ batchId: randomUUID(), quantity: 1 }] }))).toBe("batch_not_in_transfer");

    const received = await (await receive({ received: [{ batchId: soon.toUpperCase(), quantity: 990 }], shortfallReason: "One strip of ten missing" })).json();
    expect(received).toMatchObject({ status: "received", awaitingAcceptance: true, shortfallReason: "One strip of ten missing" });
    expect(await onHand(pharmacy)).toBe(1490);
    const queue = (await (await call("GET", "/stock-transfers?awaitingAcceptance=true", h.facility.id, h.finance)).json()).transfers;
    expect(queue.map((t: { id: string }) => t.id)).toEqual([transferId]);

    expect(await refusal(await post(`/stock-transfers/${transferId}/accept-shortfall`, pharmacist))).toBe("same_person");
    expect((await post(`/stock-transfers/${transferId}/accept-shortfall`, storekeeper)).status).toBe(403);
    const accepted = await (await post(`/stock-transfers/${transferId}/accept-shortfall`, h.finance)).json();
    expect(accepted).toMatchObject({ awaitingAcceptance: false, shortfallAccepted: { byName: "Test User" } });
    expect(await refusal(await post(`/stock-transfers/${transferId}/accept-shortfall`, h.finance))).toBe("no_shortfall");
    // Received and accepted, it only stands: not even the owner sends it again.
    const undo = await db.execute(sql`UPDATE stock_transfers SET status = 'sent', received_by = NULL, received_at = NULL, shortfall_reason = NULL, shortfall_accepted_by = NULL, shortfall_accepted_at = NULL WHERE id = ${transferId}`).then(() => null, (e: unknown) => e);
    expect(pgErrorCode(undo)).toBe("23001");
    expect(await refusal(await receive({}))).toBe("not_sent");
  });
});

describe("closing a request", () => {
  it("is cancelling by its requester, or declining by the sending store, before it is sent", async () => {
    const one = await created(await ask(10));
    const two = await created(await ask(10));
    const close = (id: string, how: string, who: StaffMember) => post(`/stock-transfers/${id}/${how}`, who, { reason: "Not needed now" });

    expect(await refusal(await close(one.id, "cancel", storekeeper))).toBe("not_requester");
    expect(await (await close(one.id, "cancel", pharmacist)).json()).toMatchObject({ status: "cancelled", closed: { reason: "Not needed now" } });
    expect(await (await close(two.id, "decline", storekeeper)).json()).toMatchObject({ status: "declined" });
    expect(await refusal(await close(two.id, "cancel", pharmacist))).toBe("not_open");
    expect(await refusal(await post(`/stock-transfers/${one.id}/send`, storekeeper, { lines: [{ stockItemId: paracetamol, quantity: 1 }] }))).toBe("not_open");
  });
});

describe("what a transfer touches", () => {
  it("keeps a store with a transfer still open from being retired", async () => {
    const asked = await created(await ask(10));

    expect(await refusal(await call("PATCH", `/stores/${pharmacy}`, h.facility.id, h.admin, { isActive: false }))).toBe("open_transfers");
    await post(`/stock-transfers/${asked.id}/cancel`, pharmacist, { reason: "Wrong store" });
    expect((await call("PATCH", `/stores/${pharmacy}`, h.facility.id, h.admin, { isActive: false })).status).toBe(200);
    expect(await refusal(await ask(10))).toBe("store_retired");
  });

  it("keeps a moved batch's receipt from being reversed", async () => {
    await post("/stock-transfers/send", storekeeper, { fromStoreId: main, toStoreId: pharmacy, lines: [{ stockItemId: paracetamol, batches: [{ batchId: soon, quantity: 1 }] }] });

    expect(await refusal(await post(`/stock-batches/${soon}/reverse`, storekeeper, { reason: "Typed wrong" }))).toBe("batch_moved");
  });

  it("is read by the stores' staff, nurses, finance and the auditor, not by the cashier", async () => {
    await ask(10);

    for (const who of [storekeeper, wardNurse, h.finance, h.auditor])
      expect((await call("GET", "/stock-transfers", h.facility.id, who)).status).toBe(200);
    expect((await call("GET", "/stock-transfers", h.facility.id, h.cashier)).status).toBe(403);
    expect((await call("GET", `/stock-transfers/${randomUUID()}`, h.facility.id, storekeeper)).status).toBe(404);
  });
});
