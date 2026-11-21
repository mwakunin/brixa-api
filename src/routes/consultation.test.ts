import { and, eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { StaffMember } from "@/test/hospital";

import db from "@/db";
import { auditLog } from "@/db/schema";
import { loadDrugCatalogue } from "@/lib/drug-catalogue-load";
import { loadIcd11 } from "@/lib/icd11-load";
import { addMembership, resetDb, signedInUser } from "@/test/helpers";
import { call, hospital, TODAY } from "@/test/hospital";

/** The consultation in one read, and today's complaint (decided 2026-11-20, after the staff walkthrough). */

const FIXTURES = path.resolve(import.meta.dirname, "../test/fixtures");

type Roles = Parameters<typeof addMembership>[2];

async function clinic() {
  const h = await hospital();
  const person = async (roles: Roles): Promise<StaffMember> => {
    const user = await signedInUser();
    const membership = await addMembership(user.id, h.facility.id, roles);
    return { ...user, actor: { userId: user.id, membershipId: membership.id } };
  };
  const doctor = await person(["doctor"]);
  const other = await person(["doctor"]);
  const cccNurse = await person(["nurse"]);
  const labTech = await person(["lab_tech"]);
  const supervisor = await person(["lab_supervisor"]);
  const point = async (name: string) =>
    (await (await call("POST", "/service-points", h.facility.id, h.admin, { name, kind: "consultation" })).json()).id as string;
  const gopd = await point("General OPD");
  const ccc = await point("Comprehensive Care Clinic");
  expect((await call("PATCH", `/service-points/${ccc}`, h.facility.id, h.admin, { sensitiveCategory: "hiv" })).status).toBe(200);
  expect((await call("PUT", `/staff/members/${cccNurse.actor.membershipId}/sensitive-access`, h.facility.id, h.admin, { categories: ["hiv"] })).status).toBe(200);

  const visit = async (queueAt: string, patientId?: string, kind: "opd" | "emergency" = "opd") => {
    const id = patientId ?? await h.patient();
    const res = await call("POST", "/encounters", h.facility.id, h.nurse, { patientId: id, kind, queueAt });
    expect(res.status).toBe(201);
    return { patientId: id, encounterId: (await res.json()).id as string };
  };
  const complain = (encounterId: string, text: string, who: StaffMember = h.nurse) =>
    call("PUT", `/encounters/${encounterId}/complaint`, h.facility.id, who, { text });
  const consultation = (encounterId: string, who: StaffMember = doctor) =>
    call("GET", `/encounters/${encounterId}/consultation`, h.facility.id, who);

  return { ...h, person, doctor, other, cccNurse, labTech, supervisor, gopd, ccc, visit, complain, consultation };
}

type Clinic = Awaited<ReturnType<typeof clinic>>;

function audits(c: Clinic, action: string, actorId?: string) {
  return db.select().from(auditLog).where(and(
    eq(auditLog.facilityId, c.facility.id),
    eq(auditLog.action, action as never),
    actorId ? eq(auditLog.actorId, actorId) : undefined,
  ));
}

/** A lab test ordered by the doctor, resulted by the lab and verified by a second member. */
async function resulted(c: Clinic, encounterId: string) {
  const item = (await (await call("POST", "/billable-items", c.facility.id, c.admin, { code: "MRDT", name: "Malaria rapid test", category: "lab" })).json()).id;
  const change = await (await call("POST", "/price-changes", c.facility.id, c.admin, { effectiveFrom: TODAY, reason: "Tariff", lines: [{ billableItemId: item, unitPriceCents: 30_000 }] })).json();
  await call("POST", `/price-changes/${change.id}/approve`, c.facility.id, c.finance);
  const test = await (await call("POST", "/lab-tests", c.facility.id, c.admin, {
    billableItemId: item,
    specimenType: "blood",
    analytes: [{ code: "MRDT-R", name: "Result", resultType: "choice", choices: ["Negative", "Positive"], abnormalChoices: ["Positive"] }],
  })).json();
  const order = await (await call("POST", `/encounters/${encounterId}/orders`, c.facility.id, c.doctor, { items: [{ labTestId: test.id }] })).json();
  const specimen = await (await call("POST", `/orders/${order.id}/specimens`, c.facility.id, c.labTech, { specimenType: "blood" })).json();
  const result = await (await call("POST", `/specimens/${specimen.id}/results`, c.facility.id, c.labTech, { orderItemId: order.items[0].id, values: [{ analyteId: test.analytes[0].id, value: "Positive" }] })).json();
  expect((await call("POST", `/lab-results/${result.id}/verify`, c.facility.id, c.supervisor, {})).status).toBe(200);
}

beforeEach(async () => {
  await resetDb();
  await loadIcd11(await readFile(path.join(FIXTURES, "icd11-mms-sample.txt"), "utf8"));
  await loadDrugCatalogue(await readFile(path.join(FIXTURES, "drug-catalogue-sample.csv"), "utf8"));
});

describe("today's complaint", () => {
  it("is recorded at triage, and each correction audited with the old text", async () => {
    const c = await clinic();
    const { encounterId } = await c.visit(c.gopd);

    const recorded = await c.complain(encounterId, "Fever and headache for three days");
    expect(recorded.status).toBe(200);
    expect((await recorded.json()).complaint).toEqual({
      text: "Fever and headache for three days",
      recordedAt: expect.any(String),
      recordedBy: { membershipId: c.nurse.actor.membershipId, name: expect.any(String) },
    });

    const corrected = await c.complain(encounterId, "Fever and joint pains for three days", c.doctor);
    expect((await corrected.json()).complaint.recordedBy.membershipId).toBe(c.doctor.actor.membershipId);
    expect((await c.complain(encounterId, "Fever and joint pains for three days", c.doctor)).status).toBe(200);

    // One line: a line or paragraph separator breaks it as a newline does.
    for (const text of ["Fever\nand cough", "Fever\u2028and cough", "Fever\u2029and cough"])
      expect((await c.complain(encounterId, text)).status).toBe(422);

    const entries = await audits(c, "encounter.complaint_recorded");
    expect(entries.map(e => e.detail)).toEqual(expect.arrayContaining([
      { from: null, to: "Fever and headache for three days" },
      { from: "Fever and headache for three days", to: "Fever and joint pains for three days" },
    ]));
    // Sending the same text again changes nothing, so it is not audited.
    expect(entries).toHaveLength(2);
  });

  it("is refused once the visit is over", async () => {
    const c = await clinic();
    const { encounterId } = await c.visit(c.gopd);
    expect((await call("POST", `/encounters/${encounterId}/cancel`, c.facility.id, c.nurse, { reason: "Registered twice" })).status).toBe(200);

    const res = await c.complain(encounterId, "Cough");

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("not_open");
  });

  it("is recorded by nurses and clinicians, not the front desk", async () => {
    const c = await clinic();
    const { encounterId } = await c.visit(c.gopd);
    const clerk = await c.person(["records_clerk"]);

    expect((await c.complain(encounterId, "Cough", clerk)).status).toBe(403);
  });
});

describe("the consultation", () => {
  it("brings the patient in front of the doctor in one read, audited once", async () => {
    const c = await clinic();
    const { patientId, encounterId } = await c.visit(c.gopd);
    await c.complain(encounterId, "Fever and headache for three days");
    expect((await call("POST", `/encounters/${encounterId}/observations`, c.facility.id, c.nurse, { readings: [{ code: "temperature", value: 38.4 }, { code: "weight", value: 62 }] })).status).toBe(201);
    expect((await call("POST", `/patients/${patientId}/allergies`, c.facility.id, c.nurse, { noKnownAllergies: true })).status).toBe(201);
    const diagnosis = await (await call("POST", `/encounters/${encounterId}/diagnoses`, c.facility.id, c.doctor, { code: "1F40.Z", certainty: "provisional" })).json();
    expect((await call("POST", `/encounters/${encounterId}/notes`, c.facility.id, c.doctor, { kind: "consultation", plan: "Malaria test, then review" })).status).toBe(201);
    await resulted(c, encounterId);
    const before = (await audits(c, "encounter.viewed", c.doctor.id)).length;

    const res = await c.consultation(encounterId);

    expect(res.status).toBe(200);
    const seen = await res.json();
    expect(seen.patient).toMatchObject({ id: patientId, opNumber: expect.any(String), age: expect.any(Number) });
    expect(seen.complaint.text).toBe("Fever and headache for three days");
    expect(seen.vitals.map((v: { code: string }) => v.code).sort()).toEqual(["temperature", "weight"]);
    expect(seen.allergies).toEqual([expect.objectContaining({ category: "none_known" })]);
    expect(seen.diagnoses).toEqual([expect.objectContaining({ id: diagnosis.id, code: "1F40.Z" })]);
    // The doctor's own draft is theirs to see.
    expect(seen.notes).toEqual([expect.objectContaining({ status: "draft", plan: "Malaria test, then review" })]);
    expect(seen.orders).toHaveLength(1);
    expect(seen.results).toEqual([expect.objectContaining({ status: "verified" })]);
    expect(seen.reports).toHaveLength(1);
    expect([seen.restricted, seen.lastVisit]).toEqual([[], null]);

    const viewed = await audits(c, "encounter.viewed", c.doctor.id);
    expect(viewed).toHaveLength(before + 1);
    expect(viewed.at(-1)).toMatchObject({ entityId: encounterId, summary: "Viewed the consultation" });
  }, 60_000);

  it("shows the last visit in short: its date, clinic, diagnoses and medicines", async () => {
    const c = await clinic();
    const earlier = await c.visit(c.gopd, undefined, "emergency");
    const diagnosis = await (await call("POST", `/encounters/${earlier.encounterId}/diagnoses`, c.facility.id, c.doctor, { code: "1F40.Z", certainty: "provisional" })).json();
    expect((await call("POST", `/encounters/${earlier.encounterId}/prescriptions`, c.facility.id, c.doctor, { items: [{ drugCode: "PCM-500-TAB", doseAmount: "1", frequency: "tds", durationDays: 3 }] })).status).toBe(201);
    const { encounterId } = await c.visit(c.gopd, earlier.patientId);

    const seen = await (await c.consultation(encounterId)).json();

    expect(seen.lastVisit).toEqual({
      encounterId: earlier.encounterId,
      startedAt: expect.any(String),
      restricted: false,
      clinic: "General OPD",
      diagnoses: [diagnosis.title],
      medicines: [expect.stringMatching(/paracetamol/i)],
    });
    const [entry] = (await audits(c, "encounter.viewed", c.doctor.id)).filter(e => e.summary === "Viewed the consultation");
    expect(entry.detail).toEqual({ lastVisitId: earlier.encounterId });
  });

  it("withholds a sensitive clinic's records as their own reads do, the last visit's clinic included", async () => {
    const c = await clinic();
    const earlier = await c.visit(c.ccc, undefined, "emergency");
    await call("POST", `/encounters/${earlier.encounterId}/diagnoses`, c.facility.id, c.doctor, { code: "1F40.Z", certainty: "provisional" });
    const { encounterId } = await c.visit(c.ccc, earlier.patientId);
    await c.complain(encounterId, "Here for a refill", c.doctor);

    const toOther = await (await c.consultation(encounterId, c.other)).json();

    expect(toOther.complaint).toBeNull();
    expect(toOther.restricted).toEqual([{ recordedAt: expect.any(String) }]);
    expect(toOther.lastVisit).toEqual({
      encounterId: earlier.encounterId,
      startedAt: expect.any(String),
      restricted: true,
      clinic: null,
      diagnoses: [],
      medicines: [],
    });
    // No clinic, no category, no content.
    expect(JSON.stringify(toOther)).not.toMatch(/Comprehensive|hiv|refill|1F40/i);

    // Whoever recorded the complaint sees it. A sensitive clinic's name is the visit's own, so only staff assigned its category see the last visit.
    const toDoctor = await (await c.consultation(encounterId)).json();
    expect(toDoctor.complaint.text).toBe("Here for a refill");
    expect(toDoctor.lastVisit.restricted).toBe(true);
    const toAssigned = await (await c.consultation(encounterId, c.cccNurse)).json();
    expect(toAssigned.complaint.text).toBe("Here for a refill");
    expect(toAssigned.lastVisit).toMatchObject({ restricted: false, clinic: "Comprehensive Care Clinic", diagnoses: [expect.any(String)] });
  }, 60_000);

  it("alerts whoever recorded a sensitive clinic's complaint when the glass is broken, though nothing else was recorded there", async () => {
    const c = await clinic();
    const { encounterId, patientId } = await c.visit(c.ccc);
    await c.complain(encounterId, "Here for a refill", c.doctor);

    const res = await call("POST", `/patients/${patientId}/break-glass`, c.facility.id, c.other, { reason: "Collapsed in casualty; needs regimen" });

    expect(res.status).toBe(201);
    const grant = await res.json();
    expect((await audits(c, "patient.break_glass"))[0].detail).toMatchObject({ breakGlassId: grant.id, alerted: 1 });
    const listed = (await (await call("GET", "/break-glass", c.facility.id, c.doctor)).json()).breakGlass;
    expect(listed.map((g: { id: string }) => g.id)).toEqual([grant.id]);
  });

  it("is for clinical staff only", async () => {
    const c = await clinic();
    const { encounterId } = await c.visit(c.gopd);

    expect((await c.consultation(encounterId, c.cashier)).status).toBe(403);
  });
});
