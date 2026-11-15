import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { Hospital, StaffMember } from "@/test/hospital";

import db from "@/db";
import { auditLog } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import { pgErrorCode } from "@/lib/db-errors";
import { loadDrugCatalogue } from "@/lib/drug-catalogue-load";
import { addMembership, makeOnboardedFacility, resetDb, signedInUser } from "@/test/helpers";
import { call, hospital } from "@/test/hospital";

/** P4 slice 1a: stores, stock items and reorder levels. */

const SAMPLE = path.resolve(import.meta.dirname, "../test/fixtures/drug-catalogue-sample.csv");

let h: Hospital;
let pharmacist: StaffMember;
let storekeeper: StaffMember;

async function staff(roles: Parameters<typeof addMembership>[2]): Promise<StaffMember> {
  const user = await signedInUser();
  const membership = await addMembership(user.id, h.facility.id, roles);
  return { ...user, actor: { userId: user.id, membershipId: membership.id } };
}

async function item(code: string, category: string, name = code): Promise<string> {
  const res = await call("POST", "/billable-items", h.facility.id, h.admin, { code, name, category });
  expect(res.status).toBe(201);
  return (await res.json()).id;
}

async function auditOf(action: string) {
  return db.select().from(auditLog).where(eq(auditLog.action, action as never));
}

beforeEach(async () => {
  await resetDb();
  await loadDrugCatalogue(await readFile(SAMPLE, "utf8"));
  h = await hospital();
  pharmacist = await staff(["pharmacist"]);
  storekeeper = await staff(["storekeeper"]);
});

describe("stores", () => {
  const create = (body: Record<string, unknown>, who: StaffMember = storekeeper) => call("POST", "/stores", h.facility.id, who, body);

  it("are set up by the facility admin, pharmacists and storekeepers, and read by every member", async () => {
    const res = await create({ name: "Main store", kind: "main" });
    expect(res.status).toBe(201);
    const main = await res.json();
    expect(main).toMatchObject({ name: "Main store", kind: "main", isActive: true });
    expect((await create({ name: "Pharmacy", kind: "pharmacy" }, pharmacist)).status).toBe(201);
    expect((await create({ name: "Maternity", kind: "ward" }, h.admin)).status).toBe(201);
    expect((await create({ name: "Theatre", kind: "other" }, h.nurse)).status).toBe(403);
    expect((await create({ name: "Theatre", kind: "other" }, h.cashier)).status).toBe(403);

    const listed = await (await call("GET", "/stores", h.facility.id, h.cashier)).json();
    expect(listed.stores.map((s: { name: string }) => s.name)).toEqual(["Main store", "Maternity", "Pharmacy"]);
    const [entry] = await auditOf("store.created");
    expect(entry).toMatchObject({ actorId: storekeeper.id, entityId: main.id, detail: { kind: "main" } });
  });

  it("refuses a second store of the same name, a kind it does not know, and a blank name", async () => {
    await create({ name: "Pharmacy", kind: "pharmacy" });

    const again = await create({ name: "Pharmacy", kind: "main" });
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe("name_taken");
    expect((await create({ name: "Dispensary", kind: "kiosk" })).status).toBe(422);
    expect((await create({ name: "   ", kind: "main" })).status).toBe(422);
  });

  it("is renamed or retired, audited with what it was, but never changes kind", async () => {
    const store = await (await create({ name: "Pharmacy", kind: "pharmacy" })).json();
    await create({ name: "Main store", kind: "main" });
    const update = (body: Record<string, unknown>) => call("PATCH", `/stores/${store.id}`, h.facility.id, pharmacist, body);

    const renamed = await update({ name: "OPD pharmacy", isActive: false });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ name: "OPD pharmacy", kind: "pharmacy", isActive: false });
    const [entry] = await auditOf("store.updated");
    expect(entry.detail).toEqual({ before: { name: "Pharmacy", isActive: true }, after: { name: "OPD pharmacy", isActive: false } });

    expect((await (await update({ name: "Main store" })).json()).code).toBe("name_taken");
    expect((await update({ kind: "main" })).status).toBe(422);
    expect((await update({})).status).toBe(422);
    expect((await call("PATCH", `/stores/${randomUUID()}`, h.facility.id, pharmacist, { isActive: true })).status).toBe(404);

    // Nor can a request change it behind the service's back.
    const err = await runAsFacility(h.facility.id, tx => tx.execute(sql`UPDATE stores SET kind = 'main' WHERE id = ${store.id}`))
      .then(() => null, (e: unknown) => e);
    expect(pgErrorCode(err)).toBe("42501");
  });
});

describe("stock items", () => {
  const create = (body: Record<string, unknown>, who: StaffMember = pharmacist) => call("POST", "/stock-items", h.facility.id, who, body);

  it("are a catalogue drug on a drug item, counted in a base unit and received in packs", async () => {
    const res = await create({ billableItemId: h.items.tablet, drugCode: "pcm-500-tab", baseUnit: "tablet", packSize: 1000 });
    expect(res.status).toBe(201);
    const paracetamol = await res.json();

    expect(paracetamol).toEqual({
      id: expect.any(String),
      billableItemId: h.items.tablet,
      code: "PCM-500",
      name: "PCM-500",
      category: "drug",
      drug: { code: "PCM-500-TAB", genericName: "Paracetamol", strength: "500 mg", form: "Tablet", doseUnit: "tablet", controlledSchedule: null },
      baseUnit: "tablet",
      packSize: 1000,
      isActive: true,
    });
    const [entry] = await auditOf("stock_item.created");
    expect(entry).toMatchObject({ actorId: pharmacist.id, detail: { code: "PCM-500", drugCode: "PCM-500-TAB", baseUnit: "tablet", packSize: 1000 } });
  });

  it("are a consumable on a consumable item, naming no drug", async () => {
    const gloves = await item("GLV-M", "consumable", "Examination gloves, medium");

    const res = await create({ billableItemId: gloves, baseUnit: "pair", packSize: 50 }, storekeeper);

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ code: "GLV-M", category: "consumable", drug: null, baseUnit: "pair", packSize: 50 });
  });

  it("refuses what is not an active drug or consumable item, and a drug that does not fit", async () => {
    const refusal = async (body: Record<string, unknown>) => {
      const res = await create(body);
      expect(res.status).toBe(409);
      return (await res.json()).code;
    };
    const gloves = await item("GLV-M", "consumable");
    const retired = await item("OLD-TAB", "drug");
    // No route retires an item yet; as a hand-run correction would.
    await db.execute(sql`UPDATE billable_items SET is_active = false WHERE id = ${retired}`);
    const unit = { baseUnit: "tablet", packSize: 100 };

    expect(await refusal({ billableItemId: h.items.consultation, drugCode: "PCM-500-TAB", ...unit })).toBe("not_a_stock_item");
    expect(await refusal({ billableItemId: randomUUID(), drugCode: "PCM-500-TAB", ...unit })).toBe("not_a_stock_item");
    expect(await refusal({ billableItemId: h.items.tablet, ...unit })).toBe("drug_needed");
    expect(await refusal({ billableItemId: gloves, drugCode: "PCM-500-TAB", ...unit })).toBe("not_a_drug_item");
    expect(await refusal({ billableItemId: h.items.tablet, drugCode: "NOPE-1", ...unit })).toBe("drug_not_found");

    await create({ billableItemId: h.items.tablet, drugCode: "PCM-500-TAB", ...unit });
    expect(await refusal({ billableItemId: h.items.tablet, drugCode: "PCM-500-TAB", ...unit })).toBe("already_a_stock_item");
  });

  it("refuses a drug the catalogue has retired", async () => {
    await db.execute(sql`UPDATE drug_catalogue SET retired_at = now() WHERE code = 'IBU-400-TAB'`);
    const ibuprofen = await item("IBU-400", "drug");

    const res = await create({ billableItemId: ibuprofen, drugCode: "IBU-400-TAB", baseUnit: "tablet", packSize: 100 });

    expect((await res.json()).code).toBe("drug_not_found");
  });

  it("refuses a base unit or pack size that cannot be counted", async () => {
    const body = { billableItemId: h.items.tablet, drugCode: "PCM-500-TAB" };

    expect((await create({ ...body, baseUnit: "", packSize: 100 })).status).toBe(422);
    expect((await create({ ...body, baseUnit: "tablet", packSize: 0 })).status).toBe(422);
    expect((await create({ ...body, baseUnit: "tablet", packSize: 2.5 })).status).toBe(422);
    expect((await create({ ...body, packSize: 100 })).status).toBe(422);
  });

  it("are set up by stock keepers only, and read by every member, filtered by drug", async () => {
    const morphine = await item("MOR-10", "drug", "Morphine 10 mg/mL injection");
    const amoxil = await item("AMX-500", "drug");

    expect((await create({ billableItemId: morphine, drugCode: "MOR-10-INJ", baseUnit: "mL", packSize: 10 }, h.nurse)).status).toBe(403);
    expect((await create({ billableItemId: morphine, drugCode: "MOR-10-INJ", baseUnit: "mL", packSize: 10 }, h.admin)).status).toBe(201);
    await create({ billableItemId: amoxil, drugCode: "AMX-500-CAP", baseUnit: "capsule", packSize: 100 }, storekeeper);

    const all = await (await call("GET", "/stock-items", h.facility.id, h.cashier)).json();
    expect(all.items.map((i: { code: string }) => i.code)).toEqual(["AMX-500", "MOR-10"]);
    const filtered = await (await call("GET", "/stock-items?drugCode=mor-10-inj", h.facility.id, h.nurse)).json();
    expect(filtered.items).toEqual([expect.objectContaining({ code: "MOR-10", drug: expect.objectContaining({ controlledSchedule: "II" }) })]);
  });

  it("changes its pack size or is retired, never its base unit or drug", async () => {
    const created = await (await create({ billableItemId: h.items.tablet, drugCode: "PCM-500-TAB", baseUnit: "tablet", packSize: 1000 })).json();
    const update = (body: Record<string, unknown>) => call("PATCH", `/stock-items/${created.id}`, h.facility.id, storekeeper, body);

    const res = await update({ packSize: 500, isActive: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ packSize: 500, isActive: false, baseUnit: "tablet" });
    const [entry] = await auditOf("stock_item.updated");
    expect(entry.detail).toEqual({ before: { packSize: 1000, isActive: true }, after: { packSize: 500, isActive: false } });

    expect((await update({ baseUnit: "strip" })).status).toBe(422);
    expect((await update({ drugCode: "IBU-400-TAB" })).status).toBe(422);
    expect((await call("PATCH", `/stock-items/${randomUUID()}`, h.facility.id, storekeeper, { packSize: 10 })).status).toBe(404);

    for (const column of ["base_unit", "drug_code", "billable_item_id"]) {
      const err = await runAsFacility(h.facility.id, tx => tx.execute(sql`UPDATE stock_items SET ${sql.identifier(column)} = ${column === "billable_item_id" ? h.items.consultation : "x"} WHERE id = ${created.id}`))
        .then(() => null, (e: unknown) => e);
      expect(pgErrorCode(err), column).toBe("42501");
    }
  });
});

describe("reorder levels", () => {
  let storeId: string;
  let paracetamol: string;
  let amoxil: string;

  beforeEach(async () => {
    storeId = (await (await call("POST", "/stores", h.facility.id, h.admin, { name: "Pharmacy", kind: "pharmacy" })).json()).id;
    paracetamol = (await (await call("POST", "/stock-items", h.facility.id, h.admin, { billableItemId: h.items.tablet, drugCode: "PCM-500-TAB", baseUnit: "tablet", packSize: 1000 })).json()).id;
    const amoxilItem = await item("AMX-500", "drug");
    amoxil = (await (await call("POST", "/stock-items", h.facility.id, h.admin, { billableItemId: amoxilItem, drugCode: "AMX-500-CAP", baseUnit: "capsule", packSize: 100 })).json()).id;
  });

  const set = (levels: unknown[], who: StaffMember = pharmacist, id = storeId) =>
    call("PUT", `/stores/${id}/reorder-levels`, h.facility.id, who, { levels });

  it("are set per item per store, leaving the store's others as they are, each change audited", async () => {
    expect((await set([{ stockItemId: paracetamol, level: 2000 }, { stockItemId: amoxil, level: 300 }])).status).toBe(200);

    const res = await set([{ stockItemId: paracetamol, level: 1500 }, { stockItemId: amoxil, level: 300 }], storekeeper);

    expect(res.status).toBe(200);
    expect((await res.json()).levels).toEqual([
      { stockItemId: amoxil, code: "AMX-500", name: "AMX-500", baseUnit: "capsule", level: 300 },
      { stockItemId: paracetamol, code: "PCM-500", name: "PCM-500", baseUnit: "tablet", level: 1500 },
    ]);
    const entries = await auditOf("reorder_levels.set");
    expect(entries.map(e => e.detail)).toEqual(expect.arrayContaining([
      { changes: [{ stockItemId: paracetamol, before: 2000, after: 1500 }] },
    ]));
    expect(entries).toHaveLength(2);

    // Setting one item leaves the other; setting nothing new writes nothing.
    await set([{ stockItemId: amoxil, level: 0 }]);
    await set([{ stockItemId: amoxil, level: 0 }]);
    const levels = (await (await call("GET", `/stores/${storeId}/reorder-levels`, h.facility.id, h.cashier)).json()).levels;
    expect(levels.map((l: { level: number }) => l.level)).toEqual([0, 1500]);
    expect(await auditOf("reorder_levels.set")).toHaveLength(3);
  });

  it("refuses an item that is not this facility's, a store that is not, and an item given twice", async () => {
    const elsewhere = await makeOnboardedFacility();
    const { rows: [foreign] } = await db.execute<{ id: string }>(sql`
      WITH item AS (
        INSERT INTO billable_items (facility_id, code, name, category) VALUES (${elsewhere.id}, 'PCM-500', 'Paracetamol', 'drug') RETURNING id
      )
      INSERT INTO stock_items (facility_id, billable_item_id, drug_code, base_unit, pack_size)
      SELECT ${elsewhere.id}, id, 'PCM-500-TAB', 'tablet', 100 FROM item RETURNING id
    `);

    const res = await set([{ stockItemId: foreign.id, level: 10 }]);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("item_not_found");
    expect((await set([{ stockItemId: paracetamol, level: 10 }], pharmacist, randomUUID())).status).toBe(404);
    expect((await call("GET", `/stores/${randomUUID()}/reorder-levels`, h.facility.id, pharmacist)).status).toBe(404);
    expect((await set([{ stockItemId: paracetamol, level: 10 }, { stockItemId: paracetamol, level: 20 }])).status).toBe(422);
    expect((await set([{ stockItemId: paracetamol, level: -1 }])).status).toBe(422);
    expect((await set([{ stockItemId: paracetamol, level: 10 }], h.nurse)).status).toBe(403);
  });
});

describe("the drug catalogue", () => {
  it("can be searched by whoever sets up a stock item, not only by prescribers", async () => {
    for (const who of [h.admin, storekeeper, pharmacist]) {
      const res = await call("GET", "/drugs?q=paracet", h.facility.id, who);
      expect(res.status).toBe(200);
      expect((await res.json()).drugs.length).toBeGreaterThan(0);
    }
    expect((await call("GET", "/drugs?q=paracet", h.facility.id, h.cashier)).status).toBe(403);
  });
});
