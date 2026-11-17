import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { Hospital, StaffMember } from "@/test/hospital";

import db from "@/db";
import { auditLog } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import { enterResult } from "@/lib/lab-results";
import { addMembership, backendPid, resetDb, signedInUser, waitForBlockedBackend } from "@/test/helpers";
import { call, hospital, TODAY } from "@/test/hospital";

/**
 * Results back to the clinician (decided 2026-11-17, ROADMAP.md P3): a
 * patient sent for tests comes back to the clinic once every result is
 * ready, and each clinician has a list of results to review.
 */

let h: Hospital;
let doctor: StaffMember;
let otherDoctor: StaffMember;
let labTech: StaffMember;
let supervisor: StaffMember;
let gopd: string;
let dental: string;
let mrdt: { testId: string; analyteId: string };
let hb: { testId: string; analyteId: string };
let urine: { testId: string; analyteId: string };

async function staff(roles: Parameters<typeof addMembership>[2]): Promise<StaffMember> {
  const user = await signedInUser();
  const membership = await addMembership(user.id, h.facility.id, roles);
  return { ...user, actor: { userId: user.id, membershipId: membership.id } };
}

async function api(method: string, route: string, who: StaffMember, body?: unknown, status?: number) {
  const res = await call(method, route, h.facility.id, who, body);
  if (status)
    expect(res.status, `${method} ${route}`).toBe(status);
  else
    expect(res.status, `${method} ${route}`).toBeLessThan(300);
  return res.json();
}

async function refusal(res: Response, status = 409): Promise<string> {
  expect(res.status).toBe(status);
  return (await res.json()).code;
}

async function labTest(code: string, analyte: Record<string, unknown>, specimenType = "blood") {
  const item = (await api("POST", "/billable-items", h.admin, { code, name: code, category: "lab" })).id;
  const change = await api("POST", "/price-changes", h.admin, { effectiveFrom: TODAY, reason: "Tariff", lines: [{ billableItemId: item, unitPriceCents: 30_000 }] });
  await api("POST", `/price-changes/${change.id}/approve`, h.finance);
  const test = await api("POST", "/lab-tests", h.admin, { billableItemId: item, specimenType, analytes: [analyte] });
  return { testId: test.id as string, analyteId: test.analytes[0].id as string };
}

beforeEach(async () => {
  await resetDb();
  h = await hospital();
  doctor = await staff(["doctor"]);
  otherDoctor = await staff(["doctor"]);
  labTech = await staff(["lab_tech"]);
  supervisor = await staff(["lab_supervisor"]);
  await api("POST", "/service-points", h.admin, { name: "Triage", kind: "triage" });
  gopd = (await api("POST", "/service-points", h.admin, { name: "General OPD", kind: "consultation" })).id;
  await api("PATCH", `/service-points/${gopd}`, h.admin, { consultationItemId: h.items.consultation });
  dental = (await api("POST", "/service-points", h.admin, { name: "Dental", kind: "consultation" })).id;
  mrdt = await labTest("MRDT", { code: "MPS", name: "Malaria parasites", resultType: "choice", choices: ["Negative", "Positive"], abnormalChoices: ["Positive"] });
  hb = await labTest("HB", { code: "HB", name: "Haemoglobin", resultType: "numeric", unit: "g/dL", criticalLow: 7, ranges: [{ sex: "any", low: 12, high: 16 }] });
  urine = await labTest("URINE", { code: "PROT", name: "Protein", resultType: "choice", choices: ["Nil", "Trace", "+"] }, "urine");
});

async function entryOf(encounterId: string): Promise<string | null> {
  return (await api("GET", `/encounters/${encounterId}`, h.nurse)).queue?.entryId ?? null;
}

async function queueOf(encounterId: string): Promise<string | null> {
  return (await api("GET", `/encounters/${encounterId}`, h.nurse)).queue?.servicePointId ?? null;
}

/** A patient triaged to the general clinic and called in by the doctor. */
async function withTheDoctor(who: StaffMember = doctor) {
  const patientId = await h.patient();
  const visit = (await api("POST", "/encounters", h.nurse, { patientId, kind: "opd" }, 201)).id as string;
  const triage = (await entryOf(visit))!;
  await api("POST", `/queue-entries/${triage}/serve`, h.nurse);
  await api("POST", `/queue-entries/${triage}/finish`, h.nurse, { nextServicePointId: gopd, priority: "routine" });
  const entry = (await entryOf(visit))!;
  await api("POST", `/queue-entries/${entry}/serve`, who);
  return { patientId, visit, entry };
}

/** The lab takes one blood specimen for the order's tests and enters a result for each. */
async function enter(order: { id: string; items: { id: string; labTestId: string }[] }, values: Record<string, number | string>) {
  const specimen = await api("POST", `/orders/${order.id}/specimens`, labTech, { specimenType: "blood" }, 201);
  const results: Record<string, string> = {};
  for (const item of order.items) {
    const test = item.labTestId === mrdt.testId ? mrdt : hb;
    const value = values[item.labTestId === mrdt.testId ? "MRDT" : "HB"];
    if (value === undefined)
      continue;
    results[item.labTestId === mrdt.testId ? "MRDT" : "HB"] = (await api("POST", `/specimens/${specimen.id}/results`, labTech, { orderItemId: item.id, values: [{ analyteId: test.analyteId, value }] }, 201)).id;
  }
  return { specimenId: specimen.id as string, results };
}

describe("a patient sent for tests", () => {
  it("comes back to the clinic once every result is ready, with no second fee, and the queue says so", async () => {
    const { visit, entry } = await withTheDoctor();
    const order = await api("POST", `/encounters/${visit}/orders`, doctor, { items: [{ labTestId: mrdt.testId }, { labTestId: hb.testId }] }, 201);
    const done = await api("POST", `/queue-entries/${entry}/finish`, doctor, {});
    expect(done.finished).toMatchObject({ comeBackWithResults: true, returnedWithResults: false });
    expect(await queueOf(visit)).toBeNull();

    const { results } = await enter(order, { MRDT: "Positive", HB: 13 });
    await api("POST", `/lab-results/${results.MRDT}/verify`, supervisor, {});
    // One of two: she waits at the lab for the other.
    expect(await queueOf(visit)).toBeNull();
    // Alone on night duty, the lab member releases the other: that is ready too.
    await api("POST", `/lab-results/${results.HB}/release`, labTech, { reason: "Alone on night duty" });

    expect(await queueOf(visit)).toBe(gopd);
    const queue = await api("GET", `/service-points/${gopd}/queue`, doctor);
    expect(queue.entries).toEqual([expect.objectContaining({ encounterId: visit, returnedWithResults: true, appointment: null })]);
    const fees = (await api("GET", `/encounters/${visit}/charges`, h.cashier)).charges.filter((ch: { code: string; cancelledAt: string | null }) => ch.code === "CONS" && !ch.cancelledAt);
    expect(fees).toHaveLength(1);
    // The lab member's act sent her back, and the log says so.
    const [joined] = await db.select().from(auditLog).where(and(eq(auditLog.action, "queue.joined"), eq(auditLog.actorId, labTech.id)));
    expect(joined.summary).toBe("Back at General OPD with results");

    // Seen again and finished with nothing pending, she does not come back a second time.
    const back = (await entryOf(visit))!;
    await api("POST", `/queue-entries/${back}/serve`, doctor);
    expect((await api("POST", `/queue-entries/${back}/finish`, doctor, {})).finished).toMatchObject({ comeBackWithResults: false, returnedWithResults: true });
  });

  it("stays away when the doctor says there is no need, or when she is in another queue", async () => {
    const first = await withTheDoctor();
    const noNeed = await api("POST", `/encounters/${first.visit}/orders`, doctor, { items: [{ labTestId: mrdt.testId }] }, 201);
    expect((await api("POST", `/queue-entries/${first.entry}/finish`, doctor, { comeBackWithResults: false })).finished.comeBackWithResults).toBe(false);
    const second = await withTheDoctor();
    const elsewhere = await api("POST", `/encounters/${second.visit}/orders`, doctor, { items: [{ labTestId: mrdt.testId }] }, 201);
    await api("POST", `/queue-entries/${second.entry}/finish`, doctor, { nextServicePointId: dental });

    for (const order of [noNeed, elsewhere]) {
      const { results } = await enter(order, { MRDT: "Negative" });
      await api("POST", `/lab-results/${results.MRDT}/verify`, supervisor, {});
    }

    expect(await queueOf(first.visit)).toBeNull();
    expect(await queueOf(second.visit)).toBe(dental);
  });

  it("does not wait for a test that was cancelled", async () => {
    const { visit, entry } = await withTheDoctor();
    const order = await api("POST", `/encounters/${visit}/orders`, doctor, { items: [{ labTestId: mrdt.testId }, { labTestId: hb.testId }] }, 201);
    await api("POST", `/queue-entries/${entry}/finish`, doctor, {});
    const hbItem = order.items.find((i: { labTestId: string }) => i.labTestId === hb.testId);
    await api("POST", `/order-items/${hbItem.id}/cancel`, doctor, { reason: "Not needed after all" });

    const { results } = await enter({ ...order, items: order.items.filter((i: { labTestId: string }) => i.labTestId === mrdt.testId) }, { MRDT: "Negative" });
    await api("POST", `/lab-results/${results.MRDT}/verify`, supervisor, {});

    expect(await queueOf(visit)).toBe(gopd);
  });

  it("comes back as the last test still waiting is cancelled, the others being ready", async () => {
    const { visit, entry } = await withTheDoctor();
    const order = await api("POST", `/encounters/${visit}/orders`, doctor, { items: [{ labTestId: mrdt.testId }, { labTestId: urine.testId }] }, 201);
    await api("POST", `/queue-entries/${entry}/finish`, doctor, {});
    const blood = order.items.filter((i: { labTestId: string }) => i.labTestId === mrdt.testId);
    const { results } = await enter({ ...order, items: blood }, { MRDT: "Negative" });
    await api("POST", `/lab-results/${results.MRDT}/verify`, supervisor, {});
    // The urine sample is still to come.
    expect(await queueOf(visit)).toBeNull();

    const urineItem = order.items.find((i: { labTestId: string }) => i.labTestId === urine.testId);
    await api("POST", `/order-items/${urineItem.id}/cancel`, labTech, { reason: "Could not give a sample" });

    expect(await queueOf(visit)).toBe(gopd);
    expect((await api("GET", `/service-points/${gopd}/queue`, doctor)).entries).toEqual([expect.objectContaining({ encounterId: visit, returnedWithResults: true })]);
  });

  it("stays where she is, her result still verified, when the clinic is out of use", async () => {
    const { visit, entry } = await withTheDoctor();
    const order = await api("POST", `/encounters/${visit}/orders`, doctor, { items: [{ labTestId: mrdt.testId }] }, 201);
    await api("POST", `/queue-entries/${entry}/finish`, doctor, {});
    await api("PATCH", `/service-points/${gopd}`, h.admin, { isActive: false });

    const { results } = await enter(order, { MRDT: "Negative" });
    expect(await api("POST", `/lab-results/${results.MRDT}/verify`, supervisor, {})).toMatchObject({ status: "verified" });

    expect(await queueOf(visit)).toBeNull();
    expect(await db.select().from(auditLog).where(and(eq(auditLog.action, "queue.joined"), eq(auditLog.actorId, supervisor.id)))).toEqual([]);
  });

  it("comes back with no second fee, though her first was cancelled, and whatever the fee is priced at now", async () => {
    const { visit, entry } = await withTheDoctor();
    const order = await api("POST", `/encounters/${visit}/orders`, doctor, { items: [{ labTestId: mrdt.testId }] }, 201);
    await api("POST", `/queue-entries/${entry}/finish`, doctor, {});
    // The consultation's fee is waived, and the clinic now charges an item with no price.
    const fee = (await api("GET", `/encounters/${visit}/charges`, h.cashier)).charges.find((ch: { code: string }) => ch.code === "CONS");
    await api("POST", `/charges/${fee.id}/cancel`, h.admin, { reason: "Waived by the director" });
    const unpriced = (await api("POST", "/billable-items", h.admin, { code: "CONS-B", name: "Consultation, new rate", category: "consultation" })).id;
    await api("PATCH", `/service-points/${gopd}`, h.admin, { consultationItemId: unpriced });

    const { results } = await enter(order, { MRDT: "Negative" });
    await api("POST", `/lab-results/${results.MRDT}/verify`, supervisor, {});

    // The return continues the consultation the clinic waived: it charges nothing, so no price stops it.
    expect(await queueOf(visit)).toBe(gopd);
    const standing = (await api("GET", `/encounters/${visit}/charges`, h.cashier)).charges.filter((ch: { cancelledAt: string | null; category: string }) => ch.category === "consultation" && !ch.cancelledAt);
    expect(standing).toEqual([]);
  });

  it("waits, as a result is verified, for a correction of another being written, and stays out while it waits", async () => {
    const { visit, entry } = await withTheDoctor();
    // Two orders, so two specimens and two reports: nothing but the visit is shared.
    const first = await api("POST", `/encounters/${visit}/orders`, doctor, { items: [{ labTestId: mrdt.testId }] }, 201);
    const second = await api("POST", `/encounters/${visit}/orders`, doctor, { items: [{ labTestId: hb.testId }] }, 201);
    await api("POST", `/queue-entries/${entry}/finish`, doctor, {});
    const { specimenId, results: firstResults } = await enter(first, { MRDT: "Positive" });
    const { results } = await enter(second, { HB: 13 });
    await api("POST", `/lab-results/${firstResults.MRDT}/verify`, supervisor, {});
    const mrdtItem = first.items[0];
    let release!: () => void;
    const mayCommit = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let holderPid = 0;
    const correcting = runAsFacility(h.facility.id, async (tx) => {
      try {
        await enterResult(tx, h.facility.id, specimenId, { orderItemId: mrdtItem.id, values: [{ analyteId: mrdt.analyteId, value: "Negative" }], correctionReason: "Read the wrong cassette" }, labTech.actor);
        holderPid = await backendPid(tx);
      }
      finally {
        ready();
        await mayCommit;
      }
    });
    await started;

    const verifying = call("POST", `/lab-results/${results.HB}/verify`, h.facility.id, supervisor, {});
    try {
      expect(await waitForBlockedBackend(holderPid)).toBe(true);
    }
    finally {
      release();
      await Promise.allSettled([correcting, verifying]);
    }

    expect((await verifying).status).toBe(200);
    // The malaria result is being corrected: she is not sent back until it is verified again.
    expect(await queueOf(visit)).toBeNull();
  });

  it("waits for a test whose specimen was rejected, until it is taken again and resulted", async () => {
    const { visit, entry } = await withTheDoctor();
    const order = await api("POST", `/encounters/${visit}/orders`, doctor, { items: [{ labTestId: mrdt.testId }, { labTestId: urine.testId }] }, 201);
    await api("POST", `/queue-entries/${entry}/finish`, doctor, {});
    const blood = order.items.filter((i: { labTestId: string }) => i.labTestId === mrdt.testId);
    const { results } = await enter({ ...order, items: blood }, { MRDT: "Negative" });
    const urineItem = order.items.find((i: { labTestId: string }) => i.labTestId === urine.testId);
    const sample = await api("POST", `/orders/${order.id}/specimens`, labTech, { specimenType: "urine" }, 201);
    await api("POST", `/specimens/${sample.id}/reject`, labTech, { reason: "leaked" });

    await api("POST", `/lab-results/${results.MRDT}/verify`, supervisor, {});
    expect(await queueOf(visit)).toBeNull();

    const again = await api("POST", `/specimens/${sample.id}/recollect`, labTech, undefined, 201);
    const urineResult = await api("POST", `/specimens/${again.id}/results`, labTech, { orderItemId: urineItem.id, values: [{ analyteId: urine.analyteId, value: "Nil" }] }, 201);
    await api("POST", `/lab-results/${urineResult.id}/verify`, supervisor, {});
    expect(await queueOf(visit)).toBe(gopd);
  });

  it("waits again for a result being corrected", async () => {
    const { visit, entry } = await withTheDoctor();
    const order = await api("POST", `/encounters/${visit}/orders`, doctor, { items: [{ labTestId: mrdt.testId }, { labTestId: hb.testId }] }, 201);
    await api("POST", `/queue-entries/${entry}/finish`, doctor, {});
    const { specimenId, results } = await enter(order, { MRDT: "Positive", HB: 13 });
    await api("POST", `/lab-results/${results.MRDT}/verify`, supervisor, {});
    const mrdtItem = order.items.find((i: { labTestId: string }) => i.labTestId === mrdt.testId);
    const corrected = await api("POST", `/specimens/${specimenId}/results`, labTech, { orderItemId: mrdtItem.id, values: [{ analyteId: mrdt.analyteId, value: "Negative" }], correctionReason: "Read the wrong cassette" }, 201);

    await api("POST", `/lab-results/${results.HB}/verify`, supervisor, {});
    // The malaria test's result is being corrected: she waits for it.
    expect(await queueOf(visit)).toBeNull();

    await api("POST", `/lab-results/${corrected.id}/verify`, supervisor, {});
    expect(await queueOf(visit)).toBe(gopd);
  });

  it("is told to come back only from a clinic", async () => {
    const patientId = await h.patient();
    const visit = (await api("POST", "/encounters", h.nurse, { patientId, kind: "opd" }, 201)).id;
    const triage = (await entryOf(visit))!;
    await api("POST", `/queue-entries/${triage}/serve`, h.nurse);

    expect(await refusal(await call("POST", `/queue-entries/${triage}/finish`, h.facility.id, h.nurse, { comeBackWithResults: true }))).toBe("come_back_at_clinic_only");
  });

  it("shows on her queue row the time she was booked for", async () => {
    const patientId = await h.patient();
    const booked = await api("POST", "/appointments", h.nurse, { patientId, servicePointId: gopd, date: TODAY, time: "23:59", smsReminders: false }, 201);
    const visit = (await api("POST", `/appointments/${booked.id}/check-in`, h.nurse, {})).encounterId;

    const queue = await api("GET", `/service-points/${(await api("GET", `/encounters/${visit}`, h.nurse)).queue.servicePointId}/queue`, h.nurse);

    expect(queue.entries).toEqual([expect.objectContaining({ encounterId: visit, appointment: { time: "23:59" }, returnedWithResults: false })]);
  });
});

describe("the results-to-review list", () => {
  /** An order of one test for a new patient, resulted and verified. */
  async function resulted(who: StaffMember, test: "MRDT" | "HB", value: number | string) {
    const { visit, entry } = await withTheDoctor(who);
    const order = await api("POST", `/encounters/${visit}/orders`, who, { items: [{ labTestId: test === "MRDT" ? mrdt.testId : hb.testId }] }, 201);
    await api("POST", `/queue-entries/${entry}/finish`, who, { comeBackWithResults: false });
    const { specimenId, results } = await enter(order, { [test]: value });
    const critical = test === "HB" && Number(value) < 7;
    await api("POST", `/lab-results/${results[test]}/verify`, supervisor, critical ? { told: { name: "Dr on call", how: "phone" } } : {});
    return { visit, order, specimenId, resultId: results[test] };
  }

  const listed = async (who: StaffMember, query = "") => api("GET", `/results-to-review${query}`, who);

  it("lists a clinician's results, critical then abnormal first, until each is marked reviewed", async () => {
    const normal = await resulted(doctor, "MRDT", "Negative");
    const abnormal = await resulted(doctor, "MRDT", "Positive");
    const critical = await resulted(doctor, "HB", 5);

    const mine = await listed(doctor);
    expect(mine.results.map((r: { resultId: string }) => r.resultId)).toEqual([critical.resultId, abnormal.resultId, normal.resultId]);
    expect(mine.results[0]).toMatchObject({ hasCritical: true, abnormal: true, status: "verified", test: { code: "HB", name: "HB" }, encounterId: critical.visit, visitOpen: true, orderedBy: { membershipId: doctor.actor.membershipId } });
    expect(mine.restricted).toBe(0);
    // Another doctor sees none of them as theirs, and all of them across the facility.
    expect((await listed(otherDoctor)).results).toEqual([]);
    expect((await listed(otherDoctor, "?scope=all")).results).toHaveLength(3);

    expect(await api("POST", `/lab-results/${abnormal.resultId}/reviewed`, doctor, undefined, 201)).toMatchObject({ resultId: abnormal.resultId, reviewedBy: { membershipId: doctor.actor.membershipId } });
    expect(await refusal(await call("POST", `/lab-results/${abnormal.resultId}/reviewed`, h.facility.id, otherDoctor))).toBe("already_reviewed");
    expect((await listed(doctor)).results.map((r: { resultId: string }) => r.resultId)).toEqual([critical.resultId, normal.resultId]);

    // A correction is a new result, to review again.
    const item = abnormal.order.items[0];
    const corrected = await api("POST", `/specimens/${abnormal.specimenId}/results`, labTech, { orderItemId: item.id, values: [{ analyteId: mrdt.analyteId, value: "Negative" }], correctionReason: "Read the wrong cassette" }, 201);
    expect(await refusal(await call("POST", `/lab-results/${corrected.id}/reviewed`, h.facility.id, doctor))).toBe("not_reviewable");
    await api("POST", `/lab-results/${corrected.id}/verify`, supervisor, {});
    // Negative now, so normal, and the newest.
    expect((await listed(doctor)).results.map((r: { resultId: string }) => r.resultId)).toEqual([critical.resultId, normal.resultId, corrected.id]);

    // Each read names the patients it showed, and each review who made it.
    const reads = await db.select().from(auditLog).where(eq(auditLog.action, "lab_result.review_list_viewed"));
    expect(reads[0]).toMatchObject({ actorId: doctor.id, detail: expect.objectContaining({ scope: "mine", patients: expect.arrayContaining([expect.any(String)]) }) });
    const [reviewed] = await db.select().from(auditLog).where(eq(auditLog.action, "lab_result.reviewed"));
    expect(reviewed).toMatchObject({ actorId: doctor.id, detail: { resultId: abnormal.resultId } });
  });

  it("waits, as a result is reviewed, for a correction of it being written, then refuses it", async () => {
    const { order, specimenId, resultId } = await resulted(doctor, "MRDT", "Positive");
    let release!: () => void;
    const mayCommit = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let holderPid = 0;
    const correcting = runAsFacility(h.facility.id, async (tx) => {
      try {
        await enterResult(tx, h.facility.id, specimenId, { orderItemId: order.items[0].id, values: [{ analyteId: mrdt.analyteId, value: "Negative" }], correctionReason: "Read the wrong cassette" }, labTech.actor);
        holderPid = await backendPid(tx);
      }
      finally {
        ready();
        await mayCommit;
      }
    });
    await started;

    const reviewing = call("POST", `/lab-results/${resultId}/reviewed`, h.facility.id, doctor);
    try {
      expect(await waitForBlockedBackend(holderPid)).toBe(true);
    }
    finally {
      release();
      await Promise.allSettled([correcting, reviewing]);
    }

    // The result it was is superseded: not reviewable, and not a failure.
    expect(await refusal(await reviewing)).toBe("not_reviewable");
  });

  it("is a clinician's, not the lab's or the front desk's", async () => {
    const { resultId } = await resulted(doctor, "MRDT", "Negative");

    for (const who of [labTech, h.clerk, h.cashier]) {
      expect((await call("GET", "/results-to-review", h.facility.id, who)).status).toBe(403);
      expect((await call("POST", `/lab-results/${resultId}/reviewed`, h.facility.id, who)).status).toBe(403);
    }
  });

  it("keeps a sensitive result off the list of a clinician who may not see it, and leaves out a walk-in's", async () => {
    await api("PATCH", `/lab-tests/${hb.testId}`, h.admin, { sensitiveCategory: "hiv" });
    const sensitive = await resulted(doctor, "HB", 13);
    const patientId = await h.patient();
    const walkInVisit = (await api("POST", "/encounters", h.nurse, { patientId, kind: "opd", queueAt: null }, 201)).id;
    const walkIn = await api("POST", `/encounters/${walkInVisit}/walk-in-orders`, h.nurse, { requester: { name: "Dr. W. Kamau", facility: "Mji Mpya Clinic" }, labTestIds: [mrdt.testId] }, 201);
    const { results } = await enter(walkIn, { MRDT: "Negative" });
    await api("POST", `/lab-results/${results.MRDT}/verify`, supervisor, {});

    expect((await listed(doctor)).results.map((r: { resultId: string }) => r.resultId)).toEqual([sensitive.resultId]);
    const all = await listed(otherDoctor, "?scope=all");
    expect(all).toEqual({ results: [], restricted: 1 });
    expect((await call("POST", `/lab-results/${sensitive.resultId}/reviewed`, h.facility.id, otherDoctor)).status).toBe(404);
  });
});
