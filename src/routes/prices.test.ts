import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import app from "@/app";
import db, { pool } from "@/db";
import { auditLog } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import { businessDate } from "@/lib/dates";
import { cashPriceList, resolvePrice } from "@/lib/prices";
import { facilityHeaders, makeOnboardedFacility, nextIp, resetDb, signedInUserAt } from "@/test/helpers";

type Person = Awaited<ReturnType<typeof signedInUserAt>>;

function call(method: string, path: string, facilityId: string, person: Person, body?: unknown) {
  return app.request(path, {
    method,
    headers: { ...facilityHeaders(facilityId, person), "content-type": "application/json", "x-forwarded-for": nextIp() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** A Kenyan day `offset` days from today. */
function day(offset: number) {
  const [y, m, d] = businessDate().split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
}

describe("the catalogue and its prices", () => {
  let facility: Awaited<ReturnType<typeof makeOnboardedFacility>>;
  let admin: Person;
  let finance: Person;
  let itemId: string;

  beforeEach(async () => {
    await resetDb();
    facility = await makeOnboardedFacility();
    admin = await signedInUserAt(facility.id, ["facility_admin"]);
    finance = await signedInUserAt(facility.id, ["finance_manager"]);
    itemId = (await (await call("POST", "/billable-items", facility.id, admin, { code: "cons-gen", name: "General consultation", category: "consultation" })).json()).id;
  });

  const request = (lines: { billableItemId: string; unitPriceCents: number }[], effectiveFrom = businessDate(), as = admin) =>
    call("POST", "/price-changes", facility.id, as, { effectiveFrom, reason: "Tariff review", lines });

  async function approved(unitPriceCents: number, effectiveFrom = businessDate()) {
    const change = await (await request([{ billableItemId: itemId, unitPriceCents }], effectiveFrom)).json();
    const res = await call("POST", `/price-changes/${change.id}/approve`, facility.id, finance);
    expect(res.status).toBe(200);
    return change.id as string;
  }

  function priceOn(serviceDate: string) {
    return runAsFacility(facility.id, async (tx) => {
      const price = await resolvePrice(tx, { billableItemId: itemId, priceListId: await cashPriceList(tx), serviceDate });
      return price?.unitPriceCents ?? null;
    });
  }

  async function cashPriceToday(as = admin) {
    const { items } = await (await call("GET", "/billable-items", facility.id, as)).json();
    return items.find((i: { id: string }) => i.id === itemId).cashPriceCents;
  }

  it("holds items with their own codes, and no price until one is approved", async () => {
    const nurse = await signedInUserAt(facility.id, ["nurse"]);

    expect(await cashPriceToday(nurse)).toBeNull();
    expect(await priceOn(businessDate())).toBeNull();
    const { items } = await (await call("GET", "/billable-items", facility.id, nurse)).json();
    expect(items[0]).toMatchObject({ code: "CONS-GEN", category: "consultation", isActive: true });
  });

  it("refuses a second item with the same code, and items from anyone but the keepers", async () => {
    const nurse = await signedInUserAt(facility.id, ["nurse"]);

    expect((await call("POST", "/billable-items", facility.id, admin, { code: "CONS-GEN", name: "Again", category: "service" })).status).toBe(409);
    expect((await call("POST", "/billable-items", facility.id, nurse, { code: "X1", name: "Nurse item", category: "service" })).status).toBe(403);
  });

  it("changes a price only once someone else approves it, recording old and new", async () => {
    const change = await (await request([{ billableItemId: itemId, unitPriceCents: 50_000 }])).json();
    expect(change.status).toBe("pending");
    expect(await cashPriceToday()).toBeNull();

    const own = await call("POST", `/price-changes/${change.id}/approve`, facility.id, admin);
    expect([own.status, (await own.json()).code]).toEqual([409, "same_person"]);

    expect((await call("POST", `/price-changes/${change.id}/approve`, facility.id, finance)).status).toBe(200);
    expect(await cashPriceToday()).toBe(50_000);

    await approved(65_000);
    expect(await cashPriceToday()).toBe(65_000);
    const entries = await db.select().from(auditLog).where(eq(auditLog.action, "price_change.approved"));
    expect(entries.map(e => (e.detail as { prices: unknown[] }).prices)).toEqual([
      [{ code: "CONS-GEN", from: null, to: 50_000 }],
      [{ code: "CONS-GEN", from: 50_000, to: 65_000 }],
    ]);
  });

  it("applies a future price from its day, and not before", async () => {
    await approved(50_000);
    await approved(70_000, day(5));

    expect(await priceOn(day(4))).toBe(50_000);
    expect(await priceOn(day(5))).toBe(70_000);
  });

  it("lets a nearer change replace a later one before it ever applies", async () => {
    await approved(50_000);
    await approved(70_000, day(5));
    await approved(60_000, day(2));

    expect(await priceOn(day(1))).toBe(50_000);
    expect(await priceOn(day(2))).toBe(60_000);
    expect(await priceOn(day(9))).toBe(60_000);
  });

  it("refuses a change for a day already past", async () => {
    const res = await request([{ billableItemId: itemId, unitPriceCents: 1 }], day(-1));

    expect([res.status, (await res.json()).code]).toEqual([409, "effective_in_past"]);
  });

  it("is rejected by someone else, withdrawn only by the requester, and decided once", async () => {
    const first = await (await request([{ billableItemId: itemId, unitPriceCents: 1 }])).json();
    const rejected = await call("POST", `/price-changes/${first.id}/reject`, facility.id, finance);
    expect((await rejected.json()).status).toBe("rejected");
    expect((await call("POST", `/price-changes/${first.id}/approve`, facility.id, finance)).status).toBe(409);

    const second = await (await request([{ billableItemId: itemId, unitPriceCents: 1 }])).json();
    expect((await call("POST", `/price-changes/${second.id}/withdraw`, facility.id, finance)).status).toBe(409);
    expect((await (await call("POST", `/price-changes/${second.id}/withdraw`, facility.id, admin)).json()).status).toBe("withdrawn");
    expect(await cashPriceToday()).toBeNull();
  });

  it("carries a whole tariff in one request", async () => {
    const other = (await (await call("POST", "/billable-items", facility.id, admin, { code: "BED-GEN", name: "General ward bed-day", category: "bed_day" })).json()).id;

    const change = await (await request([
      { billableItemId: itemId, unitPriceCents: 50_000 },
      { billableItemId: other, unitPriceCents: 250_050 },
    ])).json();
    await call("POST", `/price-changes/${change.id}/approve`, facility.id, finance);

    const { items } = await (await call("GET", "/billable-items", facility.id, admin)).json();
    expect(items.map((i: { code: string; cashPriceCents: number }) => [i.code, i.cashPriceCents])).toEqual([
      ["BED-GEN", 250_050],
      ["CONS-GEN", 50_000],
    ]);
  });
});

describe("the price rules, in the database itself", () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function priced() {
    const facility = await makeOnboardedFacility();
    const admin = await signedInUserAt(facility.id, ["facility_admin"]);
    const finance = await signedInUserAt(facility.id, ["finance_manager"]);
    const item = await (await call("POST", "/billable-items", facility.id, admin, { code: "LAB-FBC", name: "Full blood count", category: "lab" })).json();
    const change = await (await call("POST", "/price-changes", facility.id, admin, {
      effectiveFrom: businessDate(),
      reason: "Initial tariff",
      lines: [{ billableItemId: item.id, unitPriceCents: 80_000 }],
    })).json();
    await call("POST", `/price-changes/${change.id}/approve`, facility.id, finance);
    const { rows: [price] } = await pool.query("SELECT * FROM price_list_items LIMIT 1");
    return { change, price };
  }

  it("refuse a second price for the same item on overlapping days", async () => {
    const { price } = await priced();

    const overlap = pool.query(
      "INSERT INTO price_list_items (facility_id, price_list_id, billable_item_id, unit_price_cents, valid_from, price_change_id) VALUES ($1, $2, $3, 1, $4, $5)",
      [price.facility_id, price.price_list_id, price.billable_item_id, price.valid_from, price.price_change_id],
    );

    await expect(overlap).rejects.toMatchObject({ code: "23P01" });
  });

  it("refuse to edit a price, or to reopen one that has ended", async () => {
    const { price } = await priced();

    await expect(pool.query("UPDATE price_list_items SET unit_price_cents = 1 WHERE id = $1", [price.id])).rejects.toMatchObject({ code: "23001" });
    await pool.query("UPDATE price_list_items SET valid_to = valid_from + 3 WHERE id = $1", [price.id]);
    await expect(pool.query("UPDATE price_list_items SET valid_to = NULL WHERE id = $1", [price.id])).rejects.toMatchObject({ code: "23001" });
  });

  it("refuse to change a decided price change, or to let its requester approve it", async () => {
    const { change } = await priced();

    await expect(pool.query("UPDATE price_changes SET status = 'rejected' WHERE id = $1", [change.id])).rejects.toMatchObject({ code: "23001" });
    const selfApproved = pool.query(
      "INSERT INTO price_changes (facility_id, price_list_id, status, effective_from, reason, requested_by, decided_by, decided_at) SELECT facility_id, price_list_id, 'approved', effective_from, 'x', requested_by, requested_by, now() FROM price_changes WHERE id = $1",
      [change.id],
    );
    await expect(selfApproved).rejects.toMatchObject({ code: "23514" });
  });
});
