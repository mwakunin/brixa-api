import { and, eq, isNotNull } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { Hospital, StaffMember } from "@/test/hospital";

import db, { pool } from "@/db";
import { auditLog, charges, orderItems, orders } from "@/db/schema";
import { addDays, businessDate } from "@/lib/dates";
import { addMembership, resetDb, signedInUser } from "@/test/helpers";
import { call, hospital, TODAY } from "@/test/hospital";

/** P3 slice 4a: orders of lab tests and services, charged as they are ordered, and walk-in lab clients. */

let h: Hospital;
let doctor: StaffMember;
let labTech: StaffMember;
let clerk: StaffMember;
let items: { mrdt: string; lft: string; dressing: string; gauze: string };
let tests: { mrdt: string; lft: string };

async function staff(roles: Parameters<typeof addMembership>[2], licence?: { number: string; expiresOn: string }): Promise<StaffMember> {
  const user = await signedInUser();
  const membership = await addMembership(user.id, h.facility.id, roles, licence ? { licence } : {});
  return { ...user, actor: { userId: user.id, membershipId: membership.id } };
}

/** A billable item, priced from today when `cents` is given. */
async function item(code: string, category: string, cents: number | null): Promise<string> {
  const id = (await (await call("POST", "/billable-items", h.facility.id, h.admin, { code, name: `${code} item`, category })).json()).id as string;
  if (cents !== null) {
    const change = await (await call("POST", "/price-changes", h.facility.id, h.admin, {
      effectiveFrom: TODAY,
      reason: "Tariff",
      lines: [{ billableItemId: id, unitPriceCents: cents }],
    })).json();
    expect((await call("POST", `/price-changes/${change.id}/approve`, h.facility.id, h.finance)).status).toBe(200);
  }
  return id;
}

async function labTest(billableItemId: string): Promise<string> {
  const res = await call("POST", "/lab-tests", h.facility.id, h.admin, {
    billableItemId,
    specimenType: "blood",
    analytes: [{ code: "MPS", name: "Malaria parasites", resultType: "choice", choices: ["Negative", "Positive"], abnormalChoices: ["Positive"] }],
  });
  expect(res.status).toBe(201);
  return (await res.json()).id;
}

beforeEach(async () => {
  await resetDb();
  h = await hospital();
  doctor = await staff(["doctor"]);
  labTech = await staff(["lab_tech"]);
  clerk = await staff(["records_clerk"]);
  items = {
    mrdt: await item("MRDT", "lab", 30_000),
    lft: await item("LFT", "lab", null),
    dressing: await item("DRESS", "procedure", 20_000),
    gauze: await item("GAUZE", "consumable", 5_000),
  };
  tests = { mrdt: await labTest(items.mrdt), lft: await labTest(items.lft) };
});

async function visit(kind = "opd"): Promise<string> {
  const res = await call("POST", "/encounters", h.facility.id, h.nurse, { patientId: await h.patient(), kind, queueAt: null });
  return (await res.json()).id;
}

function order(encounterId: string, body: Record<string, unknown>, who: StaffMember = doctor) {
  return call("POST", `/encounters/${encounterId}/orders`, h.facility.id, who, body);
}
function walkIn(encounterId: string, body: Record<string, unknown>, who: StaffMember = clerk) {
  return call("POST", `/encounters/${encounterId}/walk-in-orders`, h.facility.id, who, body);
}
function cancel(itemId: string, who: StaffMember = doctor, reason = "Not needed after all") {
  return call("POST", `/order-items/${itemId}/cancel`, h.facility.id, who, { reason });
}
async function orderCharges(encounterId: string) {
  return db.select().from(charges).where(and(eq(charges.encounterId, encounterId), isNotNull(charges.orderItemId)));
}

describe("orders", () => {
  it("are placed by a clinician on an open visit, each item charged now from the cash list", async () => {
    const encounterId = await visit();

    const res = await order(encounterId, { urgency: "urgent", indication: "Fever for 3 days", items: [{ labTestId: tests.mrdt }, { billableItemId: items.dressing }] });

    expect(res.status).toBe(201);
    const placed = await res.json();
    expect(placed).toMatchObject({
      urgency: "urgent",
      indication: "Fever for 3 days",
      orderedBy: { membershipId: doctor.actor.membershipId },
      enteredBy: { membershipId: doctor.actor.membershipId },
      requester: null,
      selfRequested: false,
    });
    expect(placed.items).toEqual([
      expect.objectContaining({ kind: "service", code: "DRESS", status: "ordered", amountCents: 20_000, labTestId: null }),
      expect.objectContaining({ kind: "lab", code: "MRDT", status: "ordered", amountCents: 30_000, labTestId: tests.mrdt, billableItemId: items.mrdt }),
    ]);
    const charged = await orderCharges(encounterId);
    expect(charged.map(c => [c.amountCents, c.serviceDate, c.capturedBy]).sort()).toEqual([
      [20_000, businessDate(), doctor.actor.membershipId],
      [30_000, businessDate(), doctor.actor.membershipId],
    ]);

    const audited = await db.select().from(auditLog).where(eq(auditLog.facilityId, h.facility.id));
    expect(audited.filter(a => a.action === "charge.captured")).toHaveLength(2);
    const [placedEntry] = audited.filter(a => a.action === "order.placed");
    expect(placedEntry).toMatchObject({ actorId: doctor.id, entityId: encounterId, detail: { items: ["MRDT", "DRESS"], urgency: "urgent" } });
    // The indication is clinical: it stays in the order (rule 10).
    expect(JSON.stringify(placedEntry)).not.toContain("Fever");
  });

  it("refuse an item with no price, keeping nothing of the order", async () => {
    const encounterId = await visit();

    const res = await order(encounterId, { items: [{ labTestId: tests.mrdt }, { labTestId: tests.lft }] });

    expect([res.status, (await res.json()).code]).toEqual([409, "not_covered"]);
    expect(await db.select().from(orders)).toEqual([]);
    expect(await orderCharges(encounterId)).toEqual([]);
  });

  it("refuse what cannot be ordered, or where", async () => {
    const encounterId = await visit();
    const refused = async (body: Record<string, unknown>, on = encounterId) => {
      const res = await order(on, body);
      return [res.status, (await res.json()).code];
    };

    expect(await refused({ items: [{ billableItemId: items.gauze }] })).toEqual([409, "not_a_service"]);
    expect(await refused({ items: [{ billableItemId: items.mrdt }] })).toEqual([409, "not_a_service"]);
    expect(await refused({ items: [{ labTestId: tests.mrdt }, { labTestId: tests.mrdt }] })).toEqual([409, "duplicate_item"]);
    expect(await refused({ items: [{ labTestId: h.facility.id }] })).toEqual([409, "test_not_found"]);
    expect((await order(encounterId, { items: [{ labTestId: tests.mrdt, billableItemId: items.dressing }] })).status).toBe(422);
    // A misspelt field is refused, not dropped: an urgent order must not go in as routine.
    expect((await order(encounterId, { urgnecy: "urgent", items: [{ labTestId: tests.mrdt }] })).status).toBe(422);
    expect((await walkIn(encounterId, { selfRequested: true, urgnecy: "urgent", labTestIds: [tests.mrdt] })).status).toBe(422);

    expect((await call("PATCH", `/lab-tests/${tests.mrdt}`, h.facility.id, h.admin, { isActive: false })).status).toBe(200);
    expect(await refused({ items: [{ labTestId: tests.mrdt }] })).toEqual([409, "test_inactive"]);

    expect((await call("POST", `/encounters/${encounterId}/close`, h.facility.id, h.nurse)).status).toBe(200);
    expect(await refused({ items: [{ billableItemId: items.dressing }] })).toEqual([409, "not_open"]);
  });

  it("are placed by doctors, clinical officers and nurses under a current licence, and read by clinical staff, audited", async () => {
    const encounterId = await visit();
    const body = { items: [{ billableItemId: items.dressing }] };
    const lapsed = await staff(["clinical_officer"], { number: "CO1", expiresOn: addDays(businessDate(), -1) });

    expect((await order(encounterId, body, await staff(["clinical_officer"]))).status).toBe(201);
    expect((await order(encounterId, body, await staff(["nurse"]))).status).toBe(201);
    expect((await order(encounterId, body, clerk)).status).toBe(403);
    expect((await order(encounterId, body, labTech)).status).toBe(403);
    expect((await (await order(encounterId, body, lapsed)).json()).code).toBe("licence_expired");

    expect((await call("GET", `/encounters/${encounterId}/orders`, h.facility.id, h.cashier)).status).toBe(403);
    const listed = await call("GET", `/encounters/${encounterId}/orders`, h.facility.id, labTech);
    expect((await listed.json()).orders).toHaveLength(2);
    const viewed = await db.select().from(auditLog).where(and(eq(auditLog.action, "encounter.viewed"), eq(auditLog.actorId, labTech.id)));
    expect(viewed.map(v => v.summary)).toEqual(["Viewed orders (2)"]);
  });
});

describe("an order item", () => {
  it("is cancelled while not yet done, its charge with it while unbilled", async () => {
    const encounterId = await visit();
    const placed = await (await order(encounterId, { items: [{ labTestId: tests.mrdt }, { billableItemId: items.dressing }] })).json();
    const [dressing, mrdt] = placed.items;

    const res = await cancel(mrdt.id);

    expect(res.status).toBe(200);
    const after = await res.json();
    expect(after.items[1]).toMatchObject({ status: "cancelled", cancellationReason: "Not needed after all", amountCents: null });
    const charged = await orderCharges(encounterId);
    expect(charged.find(c => c.orderItemId === mrdt.id)).toMatchObject({ cancelledBy: doctor.actor.membershipId, cancellationReason: "Not needed after all" });
    expect(charged.find(c => c.orderItemId === dressing.id)!.cancelledAt).toBeNull();
    expect((await (await cancel(mrdt.id)).json()).code).toBe("not_ordered");
  });

  it("is not cancelled while its charge waits on a draft bill", async () => {
    const encounterId = await visit();
    const [mrdt] = (await (await order(encounterId, { items: [{ labTestId: tests.mrdt }] })).json()).items;
    const draft = await (await call("POST", `/encounters/${encounterId}/invoices`, h.facility.id, h.cashier, { kind: "interim" })).json();

    const refused = await cancel(mrdt.id);
    expect([refused.status, (await refused.json()).code]).toEqual([409, "on_draft_invoice"]);

    await call("POST", `/invoices/${draft.id}/void`, h.facility.id, h.cashier, { reason: "Patient changed their mind" });
    expect((await cancel(mrdt.id)).status).toBe(200);
    expect((await orderCharges(encounterId))[0].cancelledAt).not.toBeNull();
  });

  it("keeps its charge once billed: the bill is credited or refunded instead", async () => {
    const encounterId = await visit();
    const [mrdt] = (await (await order(encounterId, { items: [{ labTestId: tests.mrdt }] })).json()).items;
    expect((await call("POST", `/encounters/${encounterId}/bill-now`, h.facility.id, h.cashier)).status).toBe(201);

    expect((await cancel(mrdt.id)).status).toBe(200);

    const [charge] = await orderCharges(encounterId);
    expect(charge.cancelledAt).toBeNull();
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "order_item.cancelled"));
    expect(entry.detail).toMatchObject({ code: "MRDT", chargeCancelled: false });
  });

  it("is cancelled by whoever could have placed its order, or the lab for a lab test", async () => {
    const encounterId = await visit();
    const [dressing, mrdt] = (await (await order(encounterId, { items: [{ labTestId: tests.mrdt }, { billableItemId: items.dressing }] })).json()).items;
    const walkInVisit = await visit();
    const [walkInTest] = (await (await walkIn(walkInVisit, { selfRequested: true, labTestIds: [tests.mrdt] })).json()).items;

    expect((await (await cancel(mrdt.id, clerk)).json()).code).toBe("not_yours_to_cancel");
    expect((await cancel(dressing.id, labTech)).status).toBe(403);
    expect((await cancel(walkInTest.id, doctor)).status).toBe(403);
    expect((await cancel(mrdt.id, h.cashier)).status).toBe(403);

    expect((await cancel(mrdt.id, labTech, "Reagent out of stock")).status).toBe(200);
    expect((await cancel(walkInTest.id, clerk, "Client changed their mind")).status).toBe(200);
  });

  it("is marked performed by the clinician who did it, if a service; a lab test is done by collection", async () => {
    const encounterId = await visit();
    const [dressing, mrdt] = (await (await order(encounterId, { items: [{ labTestId: tests.mrdt }, { billableItemId: items.dressing }] })).json()).items;
    const nurse = await staff(["ward_nurse"]);
    const done = (id: string, who: StaffMember = nurse) => call("POST", `/order-items/${id}/done`, h.facility.id, who);

    expect((await done(dressing.id, clerk)).status).toBe(403);
    const res = await done(dressing.id);

    expect(res.status).toBe(200);
    expect((await res.json()).items[0]).toMatchObject({ status: "done", doneAt: expect.any(String), amountCents: 20_000 });
    const [row] = await db.select().from(orderItems).where(eq(orderItems.id, dressing.id));
    expect(row.doneBy).toBe(nurse.actor.membershipId);
    expect((await (await done(dressing.id)).json()).code).toBe("not_ordered");
    expect((await (await cancel(dressing.id)).json()).code).toBe("not_ordered");
    expect((await (await done(mrdt.id)).json()).code).toBe("not_a_service_item");
  });

  it("standing keeps its visit from being cancelled as opened in error, until cancelled", async () => {
    const encounterId = await visit();
    const [mrdt] = (await (await order(encounterId, { items: [{ labTestId: tests.mrdt }] })).json()).items;
    const cancelVisit = () => call("POST", `/encounters/${encounterId}/cancel`, h.facility.id, h.nurse, { reason: "Wrong patient" });

    expect((await (await cancelVisit()).json()).code).toBe("has_clinical_records");
    await cancel(mrdt.id, doctor, "Wrong patient");
    expect((await cancelVisit()).status).toBe(200);
  });
});

describe("a walk-in lab client's tests", () => {
  it("are entered from an outside requester's form, or as self-requested, each charged now", async () => {
    const encounterId = await visit();

    const outside = await walkIn(encounterId, {
      requester: { name: "Dr. Wanjiru Kamau", facility: "Mji Mpya Clinic", licenceNumber: "A1234" },
      labTestIds: [tests.mrdt],
    });
    const own = await walkIn(encounterId, { selfRequested: true, labTestIds: [tests.mrdt] }, labTech);

    expect(outside.status).toBe(201);
    expect(await outside.json()).toMatchObject({
      orderedBy: null,
      requester: { name: "Dr. Wanjiru Kamau", facility: "Mji Mpya Clinic", licenceNumber: "A1234" },
      selfRequested: false,
      enteredBy: { membershipId: clerk.actor.membershipId },
      items: [{ kind: "lab", code: "MRDT", amountCents: 30_000 }],
    });
    expect(await own.json()).toMatchObject({ orderedBy: null, requester: null, selfRequested: true, enteredBy: { membershipId: labTech.actor.membershipId } });
    expect(await orderCharges(encounterId)).toHaveLength(2);
  });

  it("name a requester or are self-requested, never both or neither, on an outpatient visit, by the desk or the lab", async () => {
    const encounterId = await visit();
    const requester = { name: "Dr. Otieno", facility: "Town Clinic" };

    expect((await walkIn(encounterId, { labTestIds: [tests.mrdt] })).status).toBe(422);
    expect((await walkIn(encounterId, { requester, selfRequested: true, labTestIds: [tests.mrdt] })).status).toBe(422);
    expect((await walkIn(encounterId, { requester, labTestIds: [tests.mrdt] }, doctor)).status).toBe(403);
    const emergency = await visit("emergency");
    expect((await (await walkIn(emergency, { requester, labTestIds: [tests.mrdt] })).json()).code).toBe("not_outpatient");
  });
});

describe("the database's order guards", () => {
  async function placed() {
    const encounterId = await visit();
    const body = await (await order(encounterId, { items: [{ billableItemId: items.dressing }] })).json();
    return { orderId: body.id as string, itemId: body.items[0].id as string };
  }

  const refusal = async (query: string, params: unknown[]) => pool.query(query, params).then(() => "accepted", (err: { message: string }) => err.message);

  it("write an order once, for every role", async () => {
    const { orderId } = await placed();

    expect(await refusal("UPDATE orders SET urgency = 'urgent' WHERE id = $1", [orderId])).toMatch(/written once/);
    expect(await refusal("DELETE FROM order_items WHERE order_id = $1", [orderId])).toMatch(/never deleted/);
  });

  it("let an item be done or cancelled once, never what it asks for", async () => {
    const { itemId } = await placed();

    expect(await refusal("UPDATE order_items SET billable_item_id = $2 WHERE id = $1", [itemId, items.mrdt])).toMatch(/never changes/);
    await pool.query("UPDATE order_items SET status = 'done', done_at = now(), done_by = $2 WHERE id = $1", [itemId, doctor.actor.membershipId]);
    expect(await refusal("UPDATE order_items SET status = 'ordered', done_at = NULL, done_by = NULL WHERE id = $1", [itemId])).toMatch(/cannot change/);
    expect(await refusal("UPDATE charges SET order_item_id = NULL, manual_reason = 'x' WHERE order_item_id = $1", [itemId])).toMatch(/never edited/);
  });

  it("name exactly one requester", async () => {
    const encounterId = await visit();
    const insert = (columns: string, values: string) => refusal(
      `INSERT INTO orders (facility_id, encounter_id, urgency, entered_by, ordered_at${columns}) VALUES ($1, $2, 'routine', $3, now()${values})`,
      [h.facility.id, encounterId, clerk.actor.membershipId],
    );

    expect(await insert("", "")).toMatch(/orders_one_requester/);
    expect(await insert(", self_requested, requester_name, requester_facility", ", true, 'Dr. X', 'Clinic'")).toMatch(/orders_one_requester/);
    expect(await insert(", requester_name", ", 'Dr. X'")).toMatch(/orders_one_requester/);
    expect(await insert(", ordered_by", `, '${doctor.actor.membershipId}'`)).toMatch(/orders_one_requester/);
    expect(await insert(", self_requested", ", true")).toBe("accepted");
  });
});
