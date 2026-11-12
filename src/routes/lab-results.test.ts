import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { Hospital, StaffMember } from "@/test/hospital";

import db, { pool } from "@/db";
import { auditLog, documents } from "@/db/schema";
import { addMembership, resetDb, signedInUser } from "@/test/helpers";
import { call, hospital, TODAY } from "@/test/hospital";

/** P3 slice 5b: results, flagged and verified, and the printed lab report. */

let h: Hospital;
let doctor: StaffMember;
let labTech: StaffMember;
let supervisor: StaffMember;
let tests: { hb: string; mrdt: string; urine: string };
let analytes: { hgb: string; comment: string; mps: string; urine: string };

async function staff(roles: Parameters<typeof addMembership>[2]): Promise<StaffMember> {
  const user = await signedInUser();
  const membership = await addMembership(user.id, h.facility.id, roles);
  return { ...user, actor: { userId: user.id, membershipId: membership.id } };
}

async function labTest(code: string, specimenType: string, testAnalytes: unknown[]) {
  const item = (await (await call("POST", "/billable-items", h.facility.id, h.admin, { code, name: `${code} test`, category: "lab" })).json()).id;
  const change = await (await call("POST", "/price-changes", h.facility.id, h.admin, { effectiveFrom: TODAY, reason: "Tariff", lines: [{ billableItemId: item, unitPriceCents: 30_000 }] })).json();
  await call("POST", `/price-changes/${change.id}/approve`, h.facility.id, h.finance);
  return (await call("POST", "/lab-tests", h.facility.id, h.admin, { billableItemId: item, specimenType, analytes: testAnalytes })).json();
}

beforeEach(async () => {
  await resetDb();
  h = await hospital();
  doctor = await staff(["doctor"]);
  labTech = await staff(["lab_tech"]);
  supervisor = await staff(["lab_supervisor"]);
  const hb = await labTest("HB", "blood", [
    {
      code: "HGB",
      name: "Haemoglobin",
      resultType: "numeric",
      unit: "g/dL",
      criticalLow: 7,
      criticalHigh: 20,
      ranges: [
        { sex: "male", ageFromDays: 6570, low: 13.5, high: 17.5 },
        { sex: "female", ageFromDays: 6570, low: 12, high: 15.5 },
        { sex: "any", ageFromDays: 0, ageToDays: 6570, low: 11, high: 16 },
      ],
    },
    { code: "COMMENT", name: "Comment", resultType: "text" },
  ]);
  const mrdt = await labTest("MRDT", "blood", [{ code: "MPS", name: "Malaria parasites", resultType: "choice", choices: ["Negative", "Positive"], abnormalChoices: ["Positive"] }]);
  const urine = await labTest("URINE", "urine", [{ code: "APP", name: "Appearance", resultType: "text" }]);
  tests = { hb: hb.id, mrdt: mrdt.id, urine: urine.id };
  analytes = { hgb: hb.analytes[0].id, comment: hb.analytes[1].id, mps: mrdt.analytes[0].id, urine: urine.analytes[0].id };
});

/** A visit with `labTestIds` ordered, and a blood specimen taken in the lab for the blood ones. */
async function tested(labTestIds = [tests.hb, tests.mrdt]) {
  const patientId = await h.patient();
  const encounterId = (await (await call("POST", "/encounters", h.facility.id, h.nurse, { patientId, kind: "opd", queueAt: null })).json()).id as string;
  const order = await (await call("POST", `/encounters/${encounterId}/orders`, h.facility.id, doctor, { items: labTestIds.map(labTestId => ({ labTestId })) })).json();
  const item = (code: string) => order.items.find((i: { code: string }) => i.code === code).id as string;
  const specimen = await (await call("POST", `/orders/${order.id}/specimens`, h.facility.id, labTech, { specimenType: "blood" })).json();
  return { patientId, encounterId, orderId: order.id as string, item, specimenId: specimen.id as string };
}

function enter(specimenId: string, body: Record<string, unknown>, who: StaffMember = labTech) {
  return call("POST", `/specimens/${specimenId}/results`, h.facility.id, who, body);
}
function act(resultId: string, action: "release" | "verify", body: Record<string, unknown> = {}, who: StaffMember = supervisor) {
  return call("POST", `/lab-results/${resultId}/${action}`, h.facility.id, who, body);
}
async function clinicianSees(encounterId: string) {
  return (await call("GET", `/encounters/${encounterId}/lab-results`, h.facility.id, doctor)).json();
}
function hb(t: { item: (code: string) => string }, hgb: number, more: Record<string, unknown> = {}) {
  return { orderItemId: t.item("HB"), values: [{ analyteId: analytes.hgb, value: hgb }], ...more };
}

describe("a result", () => {
  it("is entered per test, flagged from the range for the patient's sex and age, and frozen with it", async () => {
    const t = await tested();

    const res = await enter(t.specimenId, { orderItemId: t.item("HB"), values: [{ analyteId: analytes.hgb, value: 12.4 }, { analyteId: analytes.comment, value: "Mild hypochromia" }] });

    expect(res.status).toBe(201);
    const result = await res.json();
    expect(result).toMatchObject({ code: "HB", version: 1, status: "entered", hasCritical: false, enteredBy: { membershipId: labTech.actor.membershipId } });
    // The patient is a man of 46: the adult male range applies.
    expect(result.values).toEqual([
      expect.objectContaining({ code: "HGB", value: 12.4, unit: "g/dL", range: { low: 13.5, high: 17.5 }, flag: "low" }),
      expect.objectContaining({ code: "COMMENT", value: "Mild hypochromia", range: null, flag: null }),
    ]);
    const mrdt = await (await enter(t.specimenId, { orderItemId: t.item("MRDT"), values: [{ analyteId: analytes.mps, value: "Positive" }] })).json();
    expect(mrdt.values[0]).toMatchObject({ value: "Positive", flag: "abnormal" });

    // A later change to the ranges leaves the value as judged.
    await call("PUT", `/lab-analytes/${analytes.hgb}/ranges`, h.facility.id, h.admin, { ranges: [{ sex: "any", low: 10, high: 12 }] });
    const { toVerify } = await (await call("GET", "/lab/worklist", h.facility.id, labTech)).json();
    expect(toVerify.find((r: { id: string }) => r.id === result.id).values[0]).toMatchObject({ range: { low: 13.5, high: 17.5 }, flag: "low" });
    // Entered results stay in the lab.
    expect((await clinicianSees(t.encounterId)).results).toEqual([]);
  });

  it("takes every number and choice of its test, each of the right kind", async () => {
    const t = await tested();
    const code = async (body: Record<string, unknown>) => (await (await enter(t.specimenId, body)).json()).code;

    // A value that does not fit is a validation failure on `values`, not a conflict.
    const invalid = async (body: Record<string, unknown>) => {
      const res = await enter(t.specimenId, body);
      return [res.status, (await res.json()).error?.issues?.[0]?.path];
    };
    expect(await invalid({ orderItemId: t.item("HB"), values: [{ analyteId: analytes.comment, value: "x" }] })).toEqual([422, ["values"]]);
    expect(await invalid({ orderItemId: t.item("HB"), values: [{ analyteId: analytes.hgb, value: "high" }] })).toEqual([422, ["values"]]);
    expect(await invalid({ orderItemId: t.item("MRDT"), values: [{ analyteId: analytes.mps, value: "Maybe" }] })).toEqual([422, ["values"]]);
    expect(await invalid({ orderItemId: t.item("HB"), values: [{ analyteId: analytes.hgb, value: 14 }, { analyteId: analytes.mps, value: "Negative" }] })).toEqual([422, ["values"]]);
    const other = await tested([tests.hb]);
    expect(await code({ orderItemId: other.item("HB"), values: [{ analyteId: analytes.hgb, value: 14 }] })).toBe("not_on_specimen");
    expect((await enter(t.specimenId, hb(t, 14), doctor)).status).toBe(403);
  });

  it("reaches the clinician once another lab member verifies it", async () => {
    const t = await tested([tests.hb]);
    const result = await (await enter(t.specimenId, hb(t, 14.2))).json();

    expect((await (await act(result.id, "verify", {}, labTech)).json()).code).toBe("same_person");
    const verified = await (await act(result.id, "verify")).json();

    expect(verified).toMatchObject({ status: "verified", verifiedBy: { membershipId: supervisor.actor.membershipId } });
    expect((await clinicianSees(t.encounterId)).results).toEqual([expect.objectContaining({ id: result.id, status: "verified" })]);
    expect((await (await act(result.id, "release", { reason: "x" })).json()).code).toBe("not_pending");
    expect((await call("GET", `/encounters/${t.encounterId}/lab-results`, h.facility.id, h.cashier)).status).toBe(403);
    const [viewed] = await db.select().from(auditLog).where(eq(auditLog.action, "encounter.viewed"));
    expect(viewed).toMatchObject({ actorId: doctor.id, summary: "Viewed lab results (1)" });
  });

  it("is released unverified by the one lab member on night duty, and verified by the next", async () => {
    const t = await tested([tests.hb]);
    const result = await (await enter(t.specimenId, hb(t, 14.2))).json();

    const released = await (await act(result.id, "release", { reason: "Only lab member on night duty" }, labTech)).json();

    expect(released).toMatchObject({ status: "released", releaseReason: "Only lab member on night duty", verifiedBy: null });
    expect((await clinicianSees(t.encounterId)).results).toEqual([expect.objectContaining({ status: "released" })]);
    expect((await (await act(result.id, "verify", {}, labTech)).json()).code).toBe("same_person");
    expect(await (await act(result.id, "verify")).json()).toMatchObject({ status: "verified", releaseReason: "Only lab member on night duty" });
  });

  it("with a critical value is not released or verified until who was told is recorded", async () => {
    const t = await tested([tests.hb]);
    const result = await (await enter(t.specimenId, hb(t, 6.1))).json();
    expect(result).toMatchObject({ hasCritical: true, values: [expect.objectContaining({ flag: "critical_low" })] });

    expect((await (await act(result.id, "verify")).json()).code).toBe("told_needed");
    expect((await (await act(result.id, "release", { reason: "Night" }, labTech)).json()).code).toBe("told_needed");
    const res = await act(result.id, "verify", { told: { name: "Dr Achieng, OPD", how: "phone" } });

    expect(await res.json()).toMatchObject({ status: "verified", told: { name: "Dr Achieng, OPD", how: "phone", at: expect.any(String) } });
    const refused = await pool.query("UPDATE lab_results SET told_name = NULL, told_how = NULL, told_at = NULL, told_recorded_by = NULL WHERE id = $1", [result.id]).then(() => "accepted", (err: { message: string }) => err.message);
    expect(refused).toMatch(/once/);
  });

  it("is corrected by a new version, the old one superseded at once and kept", async () => {
    const t = await tested([tests.hb]);
    const first = await (await enter(t.specimenId, hb(t, 14.2))).json();
    await act(first.id, "verify");

    expect((await (await enter(t.specimenId, hb(t, 12.1))).json()).code).toBe("reason_needed");
    const second = await (await enter(t.specimenId, hb(t, 12.1, { correctionReason: "Transcribed from the wrong sample" }))).json();

    expect(second).toMatchObject({ version: 2, status: "entered", correctionReason: "Transcribed from the wrong sample" });
    const { rows } = await pool.query("SELECT version, status FROM lab_results ORDER BY version");
    expect(rows).toEqual([{ version: 1, status: "superseded" }, { version: 2, status: "entered" }]);
    // The wrong value is withdrawn at once; the right one reaches the clinician once verified.
    expect((await clinicianSees(t.encounterId)).results).toEqual([]);
    await act(second.id, "verify");
    expect((await clinicianSees(t.encounterId)).results).toEqual([expect.objectContaining({ version: 2, values: [expect.objectContaining({ value: 12.1 })] })]);
  });

  it("is entered against the test as it stood when the specimen was taken", async () => {
    const t = await tested([tests.hb]);
    // Since collection: a new number added, and the comment retired.
    await call("POST", `/lab-tests/${tests.hb}/analytes`, h.facility.id, h.admin, { code: "MCV", name: "Mean cell volume", resultType: "numeric", unit: "fL" });
    await call("PATCH", `/lab-analytes/${analytes.comment}`, h.facility.id, h.admin, { isActive: false });

    const res = await enter(t.specimenId, { orderItemId: t.item("HB"), values: [{ analyteId: analytes.hgb, value: 14 }, { analyteId: analytes.comment, value: "Normal film" }] });

    expect(res.status).toBe(201);
    expect((await res.json()).values.map((v: { code: string }) => v.code)).toEqual(["HGB", "COMMENT"]);
  });

  it("still needs every number it needed when the specimen was taken, though retired since", async () => {
    const t = await tested([tests.hb]);
    await call("PATCH", `/lab-analytes/${analytes.hgb}`, h.facility.id, h.admin, { isActive: false });

    const res = await enter(t.specimenId, { orderItemId: t.item("HB"), values: [{ analyteId: analytes.comment, value: "Film only" }] });

    expect([res.status, (await res.json()).error?.issues?.[0]?.message]).toEqual([422, expect.stringContaining("HGB")]);
  });

  it("does not need an analyte added while the specimen was being taken", async () => {
    // An analyte whose addition began before the collection, and committed after it read the test.
    const t = await tested([tests.hb]);
    await pool.query(
      "INSERT INTO lab_analytes (facility_id, lab_test_id, code, name, position, result_type, created_at) VALUES ($1, $2, 'PLT', 'Platelets', 9, 'numeric', now() - interval '1 hour')",
      [h.facility.id, tests.hb],
    );

    expect((await enter(t.specimenId, hb(t, 14))).status).toBe(201);
  });

  it("keeps its specimen from being rejected", async () => {
    const t = await tested([tests.hb]);
    await enter(t.specimenId, hb(t, 14.2));

    const res = await call("POST", `/specimens/${t.specimenId}/reject`, h.facility.id, labTech, { reason: "clotted" });
    expect([res.status, (await res.json()).code]).toEqual([409, "has_results"]);
  });
});

describe("the lab report", () => {
  it("is issued once every test on the order is resulted or cancelled, and issued again when a result changes", async () => {
    const t = await tested([tests.hb, tests.urine]);
    const year = TODAY.slice(0, 4);
    const first = await (await enter(t.specimenId, hb(t, 14.2, { values: [{ analyteId: analytes.hgb, value: 14.2 }, { analyteId: analytes.comment, value: "Normal film" }] }))).json();
    await act(first.id, "verify");
    expect((await clinicianSees(t.encounterId)).reports).toEqual([]);

    await call("POST", `/order-items/${t.item("URINE")}/cancel`, h.facility.id, doctor, { reason: "Patient could not give a sample" });
    const { reports } = await clinicianSees(t.encounterId);
    expect(reports).toEqual([{ orderId: t.orderId, documentId: expect.any(String), number: `LR-${year}-000001` }]);
    const [report] = await db.select().from(documents).where(eq(documents.id, reports[0].documentId));
    expect(report.content.table!.rows).toEqual([
      ["HB test", "Haemoglobin", "14.2", "g/dL", "13.5–17.5", ""],
      ["", "Comment", "Normal film", "", "", ""],
      ["URINE test", "", "Not done", "", "", "Cancelled: Patient could not give a sample"],
    ]);
    expect(report.content.fields).toEqual(expect.arrayContaining([
      { label: "Requested by", value: expect.any(String) },
      { label: "Specimens", value: expect.stringMatching(/^L-\d{8}-001 \(blood, /) },
    ]));
    const { rows: [verifier] } = await pool.query<{ name: string }>("SELECT name FROM \"user\" WHERE id = $1", [supervisor.id]);
    expect(report.content.notes).toEqual([`Verified: HB by ${verifier.name}.`]);
    expect((await call("GET", `/documents/${report.id}/pdf`, h.facility.id, labTech)).status).toBe(200);
    expect((await call("GET", `/documents/${report.id}/pdf`, h.facility.id, h.cashier)).status).toBe(403);

    // Corrected: the report is withdrawn, then issued again with the new value.
    const second = await (await enter(t.specimenId, hb(t, 12.0, { correctionReason: "Recalibrated analyser" }))).json();
    expect((await clinicianSees(t.encounterId)).reports).toEqual([]);
    await act(second.id, "release", { reason: "Only lab member on night duty" }, labTech);
    const reissued = (await clinicianSees(t.encounterId)).reports;
    expect(reissued).toEqual([expect.objectContaining({ number: `LR-${year}-000002` })]);
    const [again] = await db.select().from(documents).where(eq(documents.id, reissued[0].documentId));
    expect(again.content.table!.rows[0]).toEqual(["HB test (unverified)", "Haemoglobin", "12", "g/dL", "13.5–17.5", "L"]);
    expect(again.content.notes).toEqual(expect.arrayContaining([
      "Released unverified, to be verified: HB (Only lab member on night duty).",
      "Corrected: HB (Recalibrated analyser).",
    ]));
    const [old] = await db.select().from(documents).where(eq(documents.id, report.id));
    expect(old.voidedAt).not.toBeNull();
  });
});

describe("the lab's worklist with results", () => {
  it("lists urgent results to verify first", async () => {
    const routine = await tested([tests.hb]);
    const urgentPatient = await h.patient();
    const encounterId = (await (await call("POST", "/encounters", h.facility.id, h.nurse, { patientId: urgentPatient, kind: "opd", queueAt: null })).json()).id;
    const order = await (await call("POST", `/encounters/${encounterId}/orders`, h.facility.id, doctor, { urgency: "urgent", items: [{ labTestId: tests.hb }] })).json();
    const specimen = await (await call("POST", `/orders/${order.id}/specimens`, h.facility.id, labTech, { specimenType: "blood" })).json();
    await enter(routine.specimenId, hb(routine, 14));
    await enter(specimen.id, { orderItemId: order.items[0].id, values: [{ analyteId: analytes.hgb, value: 9 }] });

    const { toVerify } = await (await call("GET", "/lab/worklist", h.facility.id, labTech)).json();
    expect(toVerify.map((r: { orderId: string }) => r.orderId)).toEqual([order.id, routine.orderId]);
  });

  it("keeps a specimen in the lab until each of its tests is resulted, and lists results to verify", async () => {
    const t = await tested();
    const list = async () => (await call("GET", "/lab/worklist", h.facility.id, labTech)).json();

    const hbResult = await (await enter(t.specimenId, hb(t, 14.2))).json();
    expect((await list()).inLab.map((s: { id: string }) => s.id)).toEqual([t.specimenId]);
    await enter(t.specimenId, { orderItemId: t.item("MRDT"), values: [{ analyteId: analytes.mps, value: "Negative" }] });

    const after = await list();
    expect(after.inLab).toEqual([]);
    expect(after.toVerify.map((r: { code: string }) => r.code)).toEqual(["HB", "MRDT"]);
    await act(hbResult.id, "verify");
    expect((await list()).toVerify.map((r: { code: string }) => r.code)).toEqual(["MRDT"]);
  });
});

describe("the database's result guards", () => {
  it("keep a result's values and its verifier apart from its enterer, for every role", async () => {
    const t = await tested([tests.hb]);
    const result = await (await enter(t.specimenId, hb(t, 14.2))).json();
    const refusal = (query: string, params: unknown[] = [result.id]) => pool.query(query, params).then(() => "accepted", (err: { message: string }) => err.message);

    expect(await refusal("UPDATE lab_result_values SET value_numeric = 15 WHERE result_id = $1")).toMatch(/written once/);
    expect(await refusal("UPDATE lab_results SET status = 'verified', verified_at = now(), verified_by = entered_by WHERE id = $1")).toMatch(/lab_results_verified_by_another/);
    expect(await refusal("UPDATE lab_results SET entered_at = now() - interval '1 day' WHERE id = $1")).toMatch(/never change/);
    expect(await refusal("DELETE FROM lab_results WHERE id = $1")).toMatch(/never deleted/);
    // Verified, it takes no value added afterwards.
    await act(result.id, "verify");
    expect(await refusal(
      "INSERT INTO lab_result_values (facility_id, result_id, analyte_id, analyte_code, analyte_name, result_type, value_text) SELECT facility_id, id, $2, 'COMMENT', 'Comment', 'text', 'Added later' FROM lab_results WHERE id = $1",
      [result.id, analytes.comment],
    )).toMatch(/entered/);
    // Nor, verified with no critical value, a record of someone told.
    expect(await refusal("UPDATE lab_results SET told_name = 'Late', told_how = 'phone', told_at = now(), told_recorded_by = entered_by WHERE id = $1")).toMatch(/once/);
  });
});
