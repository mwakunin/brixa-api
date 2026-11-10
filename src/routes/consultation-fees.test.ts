import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { Hospital } from "@/test/hospital";

import db, { pool } from "@/db";
import { auditLog, charges } from "@/db/schema";
import { closeStaleVisits } from "@/jobs/visits";
import { addMembership, resetDb, signedInUser } from "@/test/helpers";
import { call, hospital } from "@/test/hospital";

/**
 * P3 slice 1c: a clinic's consultation fee, charged as the patient joins its
 * queue, and the cashier collecting what is due, at each point or at the end.
 */

let h: Hospital;

beforeEach(async () => {
  await resetDb();
  h = await hospital();
});

async function clinic(name = "General OPD", fee: string | null = h.items.consultation) {
  const id = (await (await call("POST", "/service-points", h.facility.id, h.admin, { name, kind: "consultation" })).json()).id as string;
  if (fee)
    expect((await call("PATCH", `/service-points/${id}`, h.facility.id, h.admin, { consultationItemId: fee })).status).toBe(200);
  return id;
}

async function doctor() {
  const user = await signedInUser();
  const membership = await addMembership(user.id, h.facility.id, ["doctor"]);
  return { ...user, actor: { userId: user.id, membershipId: membership.id } };
}

/** A visit waiting at `servicePointId`. */
async function visitAt(servicePointId: string | null) {
  return (await call("POST", "/encounters", h.facility.id, h.nurse, { patientId: await h.patient(), kind: "opd", queueAt: servicePointId })).json();
}

async function chargesOf(encounterId: string) {
  return (await (await call("GET", `/encounters/${encounterId}/charges`, h.facility.id, h.clerk)).json()).charges as {
    code: string;
    amountCents: number;
    manualReason: string | null;
    cancelledAt: string | null;
    cancellationReason: string | null;
  }[];
}

const standing = async (encounterId: string) => (await chargesOf(encounterId)).filter(c => !c.cancelledAt);

async function due() {
  return (await (await call("GET", "/cashier/due", h.facility.id, h.cashier)).json()).visits as {
    encounterId: string;
    unbilledCents: number;
    owedCents: number;
    dueCents: number;
  }[];
}

describe("a clinic's consultation fee", () => {
  it("is set by the facility admin, and only to an active consultation item at a clinic", async () => {
    const gopd = await clinic("General OPD", null);
    const triage = (await (await call("POST", "/service-points", h.facility.id, h.admin, { name: "Triage", kind: "triage" })).json()).id;
    const set = (id: string, item: string | null, who = h.admin) =>
      call("PATCH", `/service-points/${id}`, h.facility.id, who, { consultationItemId: item });

    expect(await (await set(gopd, h.items.consultation)).json()).toMatchObject({ consultationItemId: h.items.consultation });
    expect((await (await set(gopd, h.items.tablet)).json()).code).toBe("not_a_consultation_item");
    expect((await (await set(triage, h.items.consultation)).json()).code).toBe("not_a_clinic");
    expect((await set(gopd, h.items.consultation, h.nurse)).status).toBe(403);
    expect(await (await set(gopd, null)).json()).toMatchObject({ consultationItemId: null });
  });

  it("is charged once per visit per clinic, as the patient joins its queue", async () => {
    const gopd = await clinic();
    const mch = await clinic("MCH");
    const doc = await doctor();
    const visit = await visitAt(gopd);

    expect(await standing(visit.id)).toEqual([expect.objectContaining({ code: "CONS", amountCents: 50_000, manualReason: null })]);

    // Seen, sent for tests, back for review: no second fee at the same clinic.
    await call("POST", `/queue-entries/${visit.queue.entryId}/serve`, h.facility.id, doc);
    await call("POST", `/queue-entries/${visit.queue.entryId}/finish`, h.facility.id, doc, {});
    expect((await call("POST", `/encounters/${visit.id}/queue`, h.facility.id, h.nurse, { servicePointId: gopd })).status).toBe(201);
    expect(await standing(visit.id)).toHaveLength(1);

    // Referred on to another clinic with a fee of its own.
    const back = (await (await call("GET", `/encounters/${visit.id}`, h.facility.id, h.clerk)).json()).queue;
    await call("POST", `/queue-entries/${back.entryId}/serve`, h.facility.id, doc);
    await call("POST", `/queue-entries/${back.entryId}/finish`, h.facility.id, doc, { nextServicePointId: mch });
    expect(await standing(visit.id)).toHaveLength(2);

    const [captured] = await db.select().from(auditLog).where(eq(auditLog.action, "charge.captured")).limit(1);
    expect(captured).toBeDefined();
  });

  it("is not charged to a patient who leaves unseen, unless already billed", async () => {
    const gopd = await clinic();
    const unbilled = await visitAt(gopd);
    await call("POST", `/queue-entries/${unbilled.queue.entryId}/remove`, h.facility.id, h.nurse, { outcome: "left" });
    expect(await chargesOf(unbilled.id)).toEqual([expect.objectContaining({ cancellationReason: "Left without being seen" })]);
    expect(await standing(unbilled.id)).toHaveLength(0);

    const billed = await visitAt(gopd);
    expect((await call("POST", `/encounters/${billed.id}/bill-now`, h.facility.id, h.cashier)).status).toBe(201);
    await call("POST", `/queue-entries/${billed.queue.entryId}/remove`, h.facility.id, h.nurse, { outcome: "left" });
    expect(await standing(billed.id)).toHaveLength(1);
  });

  it("refuses a clinic whose fee has no price, and queues nobody there", async () => {
    const unpriced = (await (await call("POST", "/billable-items", h.facility.id, h.admin, { code: "CONS-SPEC", name: "Specialist", category: "consultation" })).json()).id;
    const special = await clinic("Specialist clinic", unpriced);
    const visit = await visitAt(null);

    const res = await call("POST", `/encounters/${visit.id}/queue`, h.facility.id, h.nurse, { servicePointId: special });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("fee_unpriced");
    expect((await (await call("GET", `/encounters/${visit.id}`, h.facility.id, h.clerk)).json()).queue).toBeNull();
  });

  it("goes with a visit cancelled as opened in error", async () => {
    const visit = await visitAt(await clinic());

    expect((await call("POST", `/encounters/${visit.id}/cancel`, h.facility.id, h.nurse, { reason: "Wrong patient" })).status).toBe(200);

    expect(await chargesOf(visit.id)).toEqual([expect.objectContaining({ cancellationReason: "The visit was cancelled" })]);
  });

  it("is cancelled by the nightly close for a patient who waited unseen, by nobody", async () => {
    const visit = await visitAt(await clinic());
    await pool.query("UPDATE encounters SET started_at = started_at - interval '1 day' WHERE id = $1", [visit.id]);

    expect(await closeStaleVisits()).toMatchObject({ closed: 1 });

    const [fee] = await db.select().from(charges).where(eq(charges.encounterId, visit.id));
    expect(fee).toMatchObject({ cancelledBy: null, cancellationReason: "Left without being seen; closed by the nightly run" });
    expect(fee.cancelledAt).not.toBeNull();
  });
});

describe("the cashier collecting what is due", () => {
  it("bills what is due now, again as more is done, and lists what each visit owes", async () => {
    const visit = await visitAt(await clinic());
    expect(await due()).toEqual([expect.objectContaining({ encounterId: visit.id, unbilledCents: 50_000, owedCents: 0, dueCents: 50_000 })]);

    const first = await (await call("POST", `/encounters/${visit.id}/bill-now`, h.facility.id, h.cashier)).json();
    expect(first).toMatchObject({ kind: "interim", status: "finalised", totalCents: 50_000, number: expect.stringMatching(/^INV-/) });
    expect(await due()).toEqual([expect.objectContaining({ encounterId: visit.id, unbilledCents: 0, owedCents: 50_000 })]);

    await call("POST", "/payments", h.facility.id, h.cashier, { patientId: visit.patientId, method: "bank", reference: "BANK 0001", amountCents: 50_000, invoiceId: first.id });
    expect(await due()).toEqual([]);

    // Two tablets later on: a second bill, for just those.
    await call("POST", `/encounters/${visit.id}/charges`, h.facility.id, h.clerk, { billableItemId: h.items.tablet, quantity: "2", reason: "Before P4" });
    const second = await (await call("POST", `/encounters/${visit.id}/bill-now`, h.facility.id, h.cashier)).json();
    expect(second).toMatchObject({ kind: "interim", totalCents: 500 });

    const nothing = await call("POST", `/encounters/${visit.id}/bill-now`, h.facility.id, h.cashier);
    expect((await nothing.json()).code).toBe("nothing_to_bill");
  });

  it("bills at the end on the final invoice, and anything after it as supplementary", async () => {
    const visit = await visitAt(await clinic());
    const final = await (await call("POST", `/encounters/${visit.id}/invoices`, h.facility.id, h.clerk, { kind: "final" })).json();
    await call("POST", `/invoices/${final.id}/finalise`, h.facility.id, h.clerk);
    await call("POST", `/encounters/${visit.id}/charges`, h.facility.id, h.clerk, { billableItemId: h.items.tablet, quantity: "2", reason: "Before P4" });

    const after = await (await call("POST", `/encounters/${visit.id}/bill-now`, h.facility.id, h.cashier)).json();

    expect(after).toMatchObject({ kind: "supplementary", totalCents: 500 });
    expect(await due()).toEqual([expect.objectContaining({ encounterId: visit.id, unbilledCents: 0, owedCents: 50_500 })]);
  });

  it("lists only open outpatient visits, for billers, audited", async () => {
    const gopd = await clinic();
    const open = await visitAt(gopd);
    const closed = await visitAt(null);
    await call("POST", `/encounters/${closed.id}/charges`, h.facility.id, h.clerk, { billableItemId: h.items.tablet, quantity: "2", reason: "Before P4" });
    await call("POST", `/encounters/${closed.id}/close`, h.facility.id, h.nurse);

    expect((await call("GET", "/cashier/due", h.facility.id, h.nurse)).status).toBe(403);
    expect((await due()).map(v => v.encounterId)).toEqual([open.id]);
    const listed = await db.select().from(auditLog).where(and(eq(auditLog.action, "billing.due_listed"), eq(auditLog.actorId, h.cashier.id)));
    expect(listed).toHaveLength(1);
  });
});

describe("the database's guards on a fee", () => {
  it("refuses a fee with two sources, a second fee for one turn, and a fee at triage", async () => {
    const visit = await visitAt(await clinic());
    const [fee] = await db.select().from(charges).where(eq(charges.encounterId, visit.id));
    const state = (query: Promise<unknown>) => query.then(() => "ok", (err: { code?: string; constraint?: string }) => err.constraint ?? err.code);
    const copy = (bedStay: string | null) => pool.query(
      `INSERT INTO charges (facility_id, encounter_id, billable_item_id, quantity, unit_price_cents, amount_cents, price_list_item_id, service_date, queue_entry_id, bed_stay_id)
       SELECT facility_id, encounter_id, billable_item_id, quantity, unit_price_cents, amount_cents, price_list_item_id, service_date, queue_entry_id, $2
       FROM charges WHERE id = $1`,
      [fee.id, bedStay],
    );

    expect(await state(copy(null))).toBe("charges_one_per_queue_entry");
    const { rows: [stay] } = await pool.query("SELECT gen_random_uuid() AS id");
    expect(await state(copy(stay.id))).toBe("charges_source_or_reason");
    expect(await state(pool.query("UPDATE charges SET queue_entry_id = NULL, manual_reason = 'x' WHERE id = $1", [fee.id]))).toBe("23001");

    const { rows: [triage] } = await pool.query(
      "INSERT INTO service_points (facility_id, name, kind) VALUES ($1, 'Triage', 'triage') RETURNING id",
      [h.facility.id],
    );
    expect(await state(pool.query("UPDATE service_points SET consultation_item_id = $2 WHERE id = $1", [triage.id, h.items.consultation]))).toBe("service_points_fee_at_a_clinic");
  });
});
