import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { Hospital, StaffMember } from "@/test/hospital";

import db, { pool } from "@/db";
import { auditLog, charges } from "@/db/schema";
import { businessDate } from "@/lib/dates";
import { addMembership, resetDb, signedInUser } from "@/test/helpers";
import { call, hospital, TODAY } from "@/test/hospital";

/** P3 slice 5a: specimens, their accession numbers, and the lab's worklist. */

let h: Hospital;
let doctor: StaffMember;
let labTech: StaffMember;
let nurse: StaffMember;
let tests: { fbc: string; mrdt: string; urine: string };

async function staff(roles: Parameters<typeof addMembership>[2]): Promise<StaffMember> {
  const user = await signedInUser();
  const membership = await addMembership(user.id, h.facility.id, roles);
  return { ...user, actor: { userId: user.id, membershipId: membership.id } };
}

/** A priced `lab` item set up as a test taking `specimenType`. */
async function labTest(code: string, specimenType: string, cents: number): Promise<string> {
  const item = (await (await call("POST", "/billable-items", h.facility.id, h.admin, { code, name: `${code} test`, category: "lab" })).json()).id;
  const change = await (await call("POST", "/price-changes", h.facility.id, h.admin, { effectiveFrom: TODAY, reason: "Tariff", lines: [{ billableItemId: item, unitPriceCents: cents }] })).json();
  await call("POST", `/price-changes/${change.id}/approve`, h.facility.id, h.finance);
  const res = await call("POST", "/lab-tests", h.facility.id, h.admin, { billableItemId: item, specimenType, analytes: [{ code: "R", name: "Result", resultType: "text" }] });
  return (await res.json()).id;
}

beforeEach(async () => {
  await resetDb();
  h = await hospital();
  doctor = await staff(["doctor"]);
  labTech = await staff(["lab_tech"]);
  nurse = await staff(["nurse"]);
  tests = { fbc: await labTest("FBC", "blood", 80_000), mrdt: await labTest("MRDT", "blood", 30_000), urine: await labTest("URINE", "urine", 40_000) };
});

async function orderedVisit(kind = "opd", labTestIds = [tests.fbc, tests.mrdt, tests.urine], urgency = "routine") {
  const patientId = await h.patient();
  const encounterId = (await (await call("POST", "/encounters", h.facility.id, h.nurse, { patientId, kind, queueAt: null })).json()).id as string;
  const order = await (await call("POST", `/encounters/${encounterId}/orders`, h.facility.id, doctor, { urgency, items: labTestIds.map(labTestId => ({ labTestId })) })).json();
  const item = (code: string) => order.items.find((i: { code: string }) => i.code === code).id as string;
  return { patientId, encounterId, orderId: order.id as string, item };
}

function collect(orderId: string, body: Record<string, unknown>, who: StaffMember = labTech) {
  return call("POST", `/orders/${orderId}/specimens`, h.facility.id, who, body);
}
function act(id: string, action: string, who: StaffMember = labTech, body?: unknown) {
  return call("POST", `/specimens/${id}/${action}`, h.facility.id, who, body);
}
const worklist = async (who: StaffMember = labTech) => (await call("GET", "/lab/worklist", h.facility.id, who)).json();
const day = () => businessDate().replaceAll("-", "");

describe("a specimen", () => {
  it("is taken for an order's waiting tests of one type, numbered for the day, and marks them done", async () => {
    const { orderId, encounterId, item } = await orderedVisit();

    const res = await collect(orderId, { specimenType: "blood" });

    expect(res.status).toBe(201);
    const blood = await res.json();
    expect(blood).toMatchObject({
      accessionNumber: `L-${day()}-001`,
      specimenType: "blood",
      // The lab took it, so it is in the lab already.
      status: "received",
      collectedBy: { membershipId: labTech.actor.membershipId },
      tests: [{ code: "FBC" }, { code: "MRDT" }],
    });
    expect((await (await collect(orderId, { specimenType: "urine" })).json()).accessionNumber).toBe(`L-${day()}-002`);
    expect((await (await collect(orderId, { specimenType: "blood" })).json()).code).toBe("nothing_to_collect");

    const { orders } = await (await call("GET", `/encounters/${encounterId}/orders`, h.facility.id, doctor)).json();
    expect(orders[0].items.map((i: { status: string }) => i.status)).toEqual(["done", "done", "done"]);
    expect((await (await call("POST", `/order-items/${item("FBC")}/cancel`, h.facility.id, doctor, { reason: "Changed mind" })).json()).code).toBe("not_ordered");
    expect((await db.select().from(charges).where(eq(charges.encounterId, encounterId))).filter(c => c.cancelledAt)).toEqual([]);
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "specimen.collected"));
    expect(entry).toMatchObject({ actorId: labTech.id, entityId: encounterId, detail: { accessionNumber: `L-${day()}-001`, received: true } });
  });

  it("taken by a nurse waits for the lab to receive it", async () => {
    const { orderId, item } = await orderedVisit();

    const taken = await (await collect(orderId, { specimenType: "blood", orderItemIds: [item("MRDT")] }, nurse)).json();

    expect(taken).toMatchObject({ status: "collected", receivedAt: null, tests: [{ code: "MRDT" }] });
    const list = await worklist();
    expect(list.toReceive.map((s: { id: string }) => s.id)).toEqual([taken.id]);
    expect(list.toCollect.map((d: { specimenType: string; tests: { code: string }[] }) => [d.specimenType, d.tests.map(t => t.code)])).toEqual([
      ["blood", ["FBC"]],
      ["urine", ["URINE"]],
    ]);
    expect((await act(taken.id, "receive", nurse)).status).toBe(403);
    expect(await (await act(taken.id, "receive")).json()).toMatchObject({ status: "received", receivedAt: expect.any(String) });
    expect((await (await act(taken.id, "receive")).json()).code).toBe("already_received");
    expect((await worklist()).inLab.map((s: { id: string }) => s.id)).toEqual([taken.id]);
  });

  it("keeps the specimen type the test was ordered with, whatever the catalogue says since", async () => {
    const { orderId } = await orderedVisit("opd", [tests.mrdt]);
    await call("PATCH", `/lab-tests/${tests.mrdt}`, h.facility.id, h.admin, { specimenType: "urine" });

    expect((await worklist()).toCollect.map((d: { specimenType: string }) => d.specimenType)).toEqual(["blood"]);
    expect((await collect(orderId, { specimenType: "blood" })).status).toBe(201);
  });

  it("is refused for a test not waiting, of another type, or on another order", async () => {
    const { orderId, item } = await orderedVisit();
    const other = await orderedVisit();
    await call("POST", `/order-items/${item("FBC")}/cancel`, h.facility.id, doctor, { reason: "Not needed" });
    const code = async (body: Record<string, unknown>) => (await (await collect(orderId, body)).json()).code;

    expect(await code({ specimenType: "blood", orderItemIds: [item("URINE")] })).toBe("not_collectable");
    expect(await code({ specimenType: "blood", orderItemIds: [item("FBC")] })).toBe("not_collectable");
    expect(await code({ specimenType: "blood", orderItemIds: [other.item("MRDT")] })).toBe("not_collectable");
    expect((await collect(orderId, { specimenType: "blood" }, h.clerk)).status).toBe(403);
    expect((await (await collect(orderId, { specimenType: "blood" })).json()).tests).toEqual([expect.objectContaining({ code: "MRDT" })]);
  });

  it("is rejected for a listed reason, keeps its number, and is recollected on a new one", async () => {
    const { orderId } = await orderedVisit();
    const first = await (await collect(orderId, { specimenType: "blood" })).json();

    expect((await act(first.id, "reject", labTech, { reason: "other" })).status).toBe(422);
    expect((await act(first.id, "reject", nurse, { reason: "clotted" })).status).toBe(403);
    expect(await (await act(first.id, "reject", labTech, { reason: "haemolysed" })).json()).toMatchObject({ status: "rejected", rejectionReason: "haemolysed" });
    expect((await (await act(first.id, "reject", labTech, { reason: "clotted" })).json()).code).toBe("already_rejected");

    const again = await act(first.id, "recollect", nurse);
    expect(again.status).toBe(201);
    const second = await again.json();
    expect(second).toMatchObject({ accessionNumber: `L-${day()}-002`, status: "collected", recollectionOf: first.id, tests: [{ code: "FBC" }, { code: "MRDT" }] });
    expect((await (await act(first.id, "recollect")).json()).code).toBe("already_recollected");
    expect((await (await act(second.id, "recollect")).json()).code).toBe("not_rejected");
    const { rows } = await pool.query("SELECT accession_number, status FROM specimens ORDER BY accession_number");
    expect(rows).toEqual([{ accession_number: `L-${day()}-001`, status: "rejected" }, { accession_number: `L-${day()}-002`, status: "collected" }]);
  });
});

describe("the lab's worklist", () => {
  it("puts urgent work first, then the oldest, and is for the lab alone, audited", async () => {
    const routine = await orderedVisit("opd", [tests.mrdt]);
    const urgent = await orderedVisit("opd", [tests.fbc], "urgent");
    const laterRoutine = await orderedVisit("opd", [tests.urine]);

    const list = await worklist();

    expect(list.toCollect.map((d: { orderId: string }) => d.orderId)).toEqual([urgent.orderId, routine.orderId, laterRoutine.orderId]);
    expect(list.toCollect[0]).toMatchObject({ urgency: "urgent", patient: { name: "Test Patient", sex: "male", opNumber: expect.any(String) } });
    expect((await call("GET", "/lab/worklist", h.facility.id, nurse)).status).toBe(403);
    const viewed = await db.select().from(auditLog).where(eq(auditLog.action, "lab.worklist_viewed"));
    expect(viewed).toEqual([expect.objectContaining({ actorId: labTech.id, summary: "Viewed the lab worklist (3 to collect, 0 to receive, 0 in the lab, 0 to verify)" })]);
  });

  it("warns of a test not yet paid for at an outpatient visit, never at an emergency, and never blocks", async () => {
    const visit = await orderedVisit("opd", [tests.mrdt]);
    const emergency = await orderedVisit("emergency", [tests.fbc]);
    const unpaid = async () => Object.fromEntries((await worklist()).toCollect.map((d: { orderId: string; tests: { unpaid: boolean }[] }) => [d.orderId, d.tests[0].unpaid]));

    expect(await unpaid()).toEqual({ [visit.orderId]: true, [emergency.orderId]: false });

    const bill = await (await call("POST", `/encounters/${visit.encounterId}/bill-now`, h.facility.id, h.cashier)).json();
    expect((await unpaid())[visit.orderId]).toBe(true);
    await call("POST", "/payments", h.facility.id, h.cashier, { patientId: visit.patientId, method: "bank", reference: "BANK 0001", amountCents: 20_000, invoiceId: bill.id });
    expect((await unpaid())[visit.orderId]).toBe(true);
    await call("POST", "/payments", h.facility.id, h.cashier, { patientId: visit.patientId, method: "bank", reference: "BANK 0002", amountCents: 10_000, invoiceId: bill.id });
    expect((await unpaid())[visit.orderId]).toBe(false);

    // Unpaid or not, the lab takes the specimen.
    const other = await orderedVisit("opd", [tests.urine]);
    expect((await collect(other.orderId, { specimenType: "urine" })).status).toBe(201);
  });
});

describe("the database's specimen guards", () => {
  it("move a specimen only forward, and keep which tests it is for", async () => {
    const { orderId } = await orderedVisit();
    const specimen = await (await collect(orderId, { specimenType: "blood" })).json();
    const refusal = (query: string) => pool.query(query, [specimen.id]).then(() => "accepted", (err: { message: string }) => err.message);

    expect(await refusal("UPDATE specimens SET status = 'collected', received_at = NULL, received_by = NULL WHERE id = $1")).toMatch(/never back/);
    expect(await refusal("UPDATE specimens SET specimen_type = 'urine' WHERE id = $1")).toMatch(/never change/);
    expect(await refusal("DELETE FROM specimen_tests WHERE specimen_id = $1")).toMatch(/written once/);
    expect(await refusal("DELETE FROM specimens WHERE id = $1")).toMatch(/never deleted/);
    await pool.query("UPDATE specimens SET status = 'rejected', rejected_at = now(), rejected_by = received_by, rejection_reason = 'leaked' WHERE id = $1", [specimen.id]);
    expect(await refusal("UPDATE specimens SET rejection_note = 'late note' WHERE id = $1")).toMatch(/cannot change/);
  });
});
