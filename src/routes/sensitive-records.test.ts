import { and, eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { StaffMember } from "@/test/hospital";

import db, { pool } from "@/db";
import { auditLog, breakGlassGrants, charges, invoiceLines } from "@/db/schema";
import { loadDrugCatalogue } from "@/lib/drug-catalogue-load";
import { loadIcd11 } from "@/lib/icd11-load";
import { categoryOfCode } from "@/lib/sensitivity";
import { addMembership, resetDb, signedInUser } from "@/test/helpers";
import { call, hospital, TODAY } from "@/test/hospital";

/** P3 slice 7: sensitive records, break-glass, and neutral names on bills. */

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
  const pharmacist = await person(["pharmacist"]);
  const point = async (name: string, kind: "triage" | "consultation") =>
    (await (await call("POST", "/service-points", h.facility.id, h.admin, { name, kind })).json()).id as string;
  const gopd = await point("General OPD", "consultation");
  const ccc = await point("Comprehensive Care Clinic", "consultation");
  expect((await call("PATCH", `/service-points/${ccc}`, h.facility.id, h.admin, { sensitiveCategory: "hiv" })).status).toBe(200);
  expect((await call("PUT", `/staff/members/${cccNurse.actor.membershipId}/sensitive-access`, h.facility.id, h.admin, { categories: ["hiv"] })).status).toBe(200);

  /** An outpatient visit, joined at `queueAt`. */
  const visit = async (queueAt: string | null, patientId?: string) => {
    const id = patientId ?? await h.patient();
    const encounter = await (await call("POST", "/encounters", h.facility.id, h.nurse, { patientId: id, kind: "opd", queueAt })).json();
    return { patientId: id, encounterId: encounter.id as string };
  };
  const note = async (encounterId: string, body: Record<string, unknown> = {}, who = doctor) => {
    const draft = await (await call("POST", `/encounters/${encounterId}/notes`, h.facility.id, who, { kind: "consultation", plan: "Review in two weeks", ...body })).json();
    return (await (await call("POST", `/notes/${draft.id}/sign`, h.facility.id, who)).json()).id as string;
  };
  const diagnose = async (encounterId: string, code: string, who = doctor) =>
    (await (await call("POST", `/encounters/${encounterId}/diagnoses`, h.facility.id, who, { code, certainty: "provisional" })).json()).id as string;
  const read = async (encounterId: string, what: "notes" | "diagnoses" | "orders" | "lab-results", who: StaffMember) =>
    (await call("GET", `/encounters/${encounterId}/${what}`, h.facility.id, who)).json();

  const labTest = async (code: string, sensitiveCategory?: string) => {
    const item = (await (await call("POST", "/billable-items", h.facility.id, h.admin, { code, name: `${code} test`, category: "lab" })).json()).id;
    const change = await (await call("POST", "/price-changes", h.facility.id, h.admin, { effectiveFrom: TODAY, reason: "Tariff", lines: [{ billableItemId: item, unitPriceCents: 30_000 }] })).json();
    await call("POST", `/price-changes/${change.id}/approve`, h.facility.id, h.finance);
    const test = await (await call("POST", "/lab-tests", h.facility.id, h.admin, {
      billableItemId: item,
      specimenType: "blood",
      ...(sensitiveCategory ? { sensitiveCategory } : {}),
      analytes: [{ code: `${code}-R`, name: "Result", resultType: "choice", choices: ["Negative", "Positive"], abnormalChoices: ["Positive"] }],
    })).json();
    return { itemId: item as string, testId: test.id as string, analyteId: test.analytes[0].id as string };
  };

  return { ...h, person, doctor, other, cccNurse, labTech, supervisor, pharmacist, gopd, ccc, visit, note, diagnose, read, labTest };
}

type Clinic = Awaited<ReturnType<typeof clinic>>;

async function audits(c: Clinic, action: string, actorId?: string) {
  return db.select().from(auditLog).where(and(
    eq(auditLog.facilityId, c.facility.id),
    eq(auditLog.action, action as never),
    actorId ? eq(auditLog.actorId, actorId) : undefined,
  ));
}

/** A lab test ordered by the doctor, collected and resulted by the lab, verified: its report issued. */
async function resulted(c: Clinic, encounterId: string, test: { testId: string; analyteId: string }) {
  const order = await (await call("POST", `/encounters/${encounterId}/orders`, c.facility.id, c.doctor, { items: [{ labTestId: test.testId }] })).json();
  const specimen = await (await call("POST", `/orders/${order.id}/specimens`, c.facility.id, c.labTech, { specimenType: "blood" })).json();
  const result = await (await call("POST", `/specimens/${specimen.id}/results`, c.facility.id, c.labTech, { orderItemId: order.items[0].id, values: [{ analyteId: test.analyteId, value: "Negative" }] })).json();
  expect((await call("POST", `/lab-results/${result.id}/verify`, c.facility.id, c.supervisor, {})).status).toBe(200);
  return { order, resultId: result.id as string };
}

beforeEach(async () => {
  await resetDb();
  await loadIcd11(await readFile(path.join(FIXTURES, "icd11-mms-sample.txt"), "utf8"));
  await loadDrugCatalogue(await readFile(path.join(FIXTURES, "drug-catalogue-sample.csv"), "utf8"));
});

describe("restricted records", () => {
  it("in a visit to a sensitive clinic are seen by who recorded them and staff assigned the category, and listed as restricted to others", async () => {
    const c = await clinic();
    const { encounterId } = await c.visit(c.ccc);
    await c.note(encounterId);
    await c.diagnose(encounterId, "1F40.Z");

    const others = { notes: await c.read(encounterId, "notes", c.other), diagnoses: await c.read(encounterId, "diagnoses", c.other) };

    expect(others.notes.notes).toEqual([]);
    expect(others.notes.restricted).toEqual([{ recordedAt: expect.any(String) }]);
    expect(others.diagnoses).toEqual({ diagnoses: [], restricted: [{ recordedAt: expect.any(String) }] });
    // No category, no content: only that something is there, and when.
    expect(JSON.stringify(others)).not.toMatch(/hiv|1F40|Review/i);
    for (const reader of [c.doctor, c.cccNurse]) {
      const seen = await c.read(encounterId, "notes", reader);
      expect([seen.notes.length, seen.restricted]).toEqual([1, []]);
    }
    const [read] = await audits(c, "encounter.viewed", c.other.id);
    expect(read.detail).toEqual({ restricted: 1 });
  });

  it("from a sensitive code, a marked lab test or a marked note restrict only themselves", async () => {
    const c = await clinic();
    expect([categoryOfCode("1C62.Z"), categoryOfCode("6A70"), categoryOfCode("1F40.Z")]).toEqual(["hiv", "mental_health", null]);
    const hiv = await c.labTest("HIV", "hiv");
    const fbc = await c.labTest("FBC");
    const { encounterId } = await c.visit(c.gopd);
    await c.diagnose(encounterId, "1C62.Z");
    await c.diagnose(encounterId, "1F40.Z");
    const plain = await c.note(encounterId);
    const marked = await c.note(encounterId, { plan: "Disclosed at home" });
    expect((await call("POST", `/notes/${marked}/sensitive`, c.facility.id, c.doctor, { category: "gbv" })).status).toBe(200);
    expect((await (await call("POST", `/notes/${marked}/sensitive`, c.facility.id, c.doctor, { category: "hiv" })).json()).code).toBe("already_sensitive");
    // Only the author marks a note.
    expect((await call("POST", `/notes/${plain}/sensitive`, c.facility.id, c.other, { category: "gbv" })).status).toBe(404);
    const hivTest = await resulted(c, encounterId, hiv);
    const fbcTest = await resulted(c, encounterId, fbc);

    const notes = await c.read(encounterId, "notes", c.other);
    const diagnoses = await c.read(encounterId, "diagnoses", c.other);
    const orders = await c.read(encounterId, "orders", c.other);
    const results = await c.read(encounterId, "lab-results", c.other);

    expect([notes.notes.map((n: { id: string }) => n.id), notes.restricted.length]).toEqual([[plain], 1]);
    expect([diagnoses.diagnoses.map((d: { code: string }) => d.code), diagnoses.restricted.length]).toEqual([["1F40.Z"], 1]);
    expect([orders.orders.map((o: { id: string }) => o.id), orders.restricted.length]).toEqual([[fbcTest.order.id], 1]);
    expect([results.results.map((r: { id: string }) => r.id), results.restricted.length]).toEqual([[fbcTest.resultId], 1]);
    expect(results.reports.map((r: { orderId: string }) => r.orderId)).toEqual([fbcTest.order.id]);
    // The ordering doctor sees their own HIV test and its result.
    expect((await c.read(encounterId, "lab-results", c.doctor)).results.map((r: { id: string }) => r.id).sort()).toEqual([hivTest.resultId, fbcTest.resultId].sort());

    // The report opens for the lab, whose work it is, and not for the other doctor.
    const hivReport = (await (await call("GET", `/encounters/${encounterId}/lab-results`, c.facility.id, c.doctor)).json()).reports.find((r: { orderId: string }) => r.orderId === hivTest.order.id).documentId;
    const refused = await call("GET", `/documents/${hivReport}/pdf`, c.facility.id, c.other);
    expect([refused.status, (await refused.json()).code]).toEqual([403, "restricted"]);
    expect((await call("GET", `/documents/${hivReport}/pdf`, c.facility.id, c.labTech)).status).toBe(200);
  });

  it("are not there for a write by someone who may not see them", async () => {
    const c = await clinic();
    const hiv = await c.labTest("HIV", "hiv");
    const { encounterId } = await c.visit(c.ccc);
    const noteId = await c.note(encounterId);
    const diagnosisId = await c.diagnose(encounterId, "1F40.Z");
    const order = await (await call("POST", `/encounters/${encounterId}/orders`, c.facility.id, c.doctor, { items: [{ labTestId: hiv.testId }] })).json();
    const prescription = await (await call("POST", `/encounters/${encounterId}/prescriptions`, c.facility.id, c.doctor, { items: [{ drugCode: "PCM-500-TAB", doseAmount: "1", frequency: "tds", durationDays: 3 }] })).json();

    expect((await call("POST", `/notes/${noteId}/addenda`, c.facility.id, c.other, { text: "Seen" })).status).toBe(404);
    expect((await call("POST", `/notes/${noteId}/entered-in-error`, c.facility.id, c.other, { reason: "Wrong patient" })).status).toBe(404);
    expect((await call("POST", `/diagnoses/${diagnosisId}/confirm`, c.facility.id, c.other)).status).toBe(404);
    expect((await call("POST", `/order-items/${order.items[0].id}/cancel`, c.facility.id, c.other, { reason: "Not needed" })).status).toBe(404);
    expect((await call("POST", `/prescriptions/${prescription.id}/cancel`, c.facility.id, c.other, { reason: "Changed" })).status).toBe(404);

    // The prescription opens for the pharmacy, whose work it is, not for the other doctor.
    expect((await call("GET", `/documents/${prescription.prescription.documentId}/pdf`, c.facility.id, c.other)).status).toBe(403);
    expect((await audits(c, "document.view_refused", c.other.id)).map(a => a.entityId)).toEqual([prescription.prescription.documentId]);
    expect((await call("GET", `/documents/${prescription.prescription.documentId}/pdf`, c.facility.id, c.pharmacist)).status).toBe(200);
    // The lab cancels a test it cannot run, its own work.
    expect((await call("POST", `/order-items/${order.items[0].id}/cancel`, c.facility.id, c.labTech, { reason: "Kits out" })).status).toBe(200);
    // Staff assigned the category may.
    expect((await call("POST", `/notes/${noteId}/addenda`, c.facility.id, c.cccNurse, { text: "Counselled" })).status).toBe(201);
  });
});

describe("breaking the glass", () => {
  it("opens the patient's restricted records for 12 hours, audited, and alerts who recorded them", async () => {
    const c = await clinic();
    const { encounterId, patientId } = await c.visit(c.ccc);
    await c.note(encounterId);

    expect((await call("POST", `/patients/${patientId}/break-glass`, c.facility.id, c.other, { reason: " " })).status).toBe(422);
    expect((await call("POST", `/patients/${patientId}/break-glass`, c.facility.id, c.clerk, { reason: "Curious" })).status).toBe(403);
    const lapsed = await c.person(["doctor"]);
    await pool.query("UPDATE memberships SET licence_expires_on = $2 WHERE id = $1", [lapsed.actor.membershipId, "2020-01-01"]);
    expect((await call("POST", `/patients/${patientId}/break-glass`, c.facility.id, lapsed, { reason: "Curious" })).status).toBe(403);
    // Refused, yet on record: written in a transaction of their own, which the 403 does not roll back.
    expect((await audits(c, "patient.break_glass_refused")).map(a => [a.actorId, a.entityId])).toEqual([[c.clerk.id, patientId], [lapsed.id, patientId]]);
    const before = Date.now();
    const res = await call("POST", `/patients/${patientId}/break-glass`, c.facility.id, c.other, { reason: "Collapsed in casualty; needs regimen" });
    const after = Date.now();

    expect(res.status).toBe(201);
    const grant = await res.json();
    const expires = new Date(grant.expiresAt).getTime();
    expect(expires).toBeGreaterThanOrEqual(before + 12 * 3_600_000);
    expect(expires).toBeLessThanOrEqual(after + 12 * 3_600_000);
    const seen = await c.read(encounterId, "notes", c.other);
    expect([seen.notes.length, seen.restricted]).toEqual([1, []]);
    const reads = await audits(c, "encounter.viewed", c.other.id);
    expect(reads.at(-1)?.detail).toEqual({ breakGlassId: grant.id });
    expect((await audits(c, "patient.break_glass"))[0].detail).toMatchObject({ breakGlassId: grant.id, alerted: 1 });

    // The author is alerted; staff who recorded nothing of it are not; the admin sees every one.
    const list = async (who: StaffMember) => (await (await call("GET", "/break-glass", c.facility.id, who)).json()).breakGlass;
    expect(await list(c.doctor)).toEqual([expect.objectContaining({ id: grant.id, reason: "Collapsed in casualty; needs regimen", grantedTo: { membershipId: c.other.actor.membershipId, name: expect.any(String) }, review: null })]);
    expect(await list(c.cccNurse)).toEqual([]);
    expect((await list(c.admin)).map((g: { id: string }) => g.id)).toEqual([grant.id]);
    expect((await call("GET", "/break-glass", c.facility.id, c.cashier)).status).toBe(403);

    const review = () => call("POST", `/break-glass/${grant.id}/review`, c.facility.id, c.admin, { note: "Emergency, justified" });
    expect((await review()).status).toBe(200);
    expect((await (await review()).json()).code).toBe("already_reviewed");
    expect((await call("POST", `/break-glass/${grant.id}/review`, c.facility.id, c.doctor, {})).status).toBe(403);
    expect((await (await call("GET", "/break-glass?unreviewed=true", c.facility.id, c.admin)).json()).breakGlass).toEqual([]);

    // A grant that has lapsed opens nothing.
    const later = await c.person(["doctor"]);
    await db.insert(breakGlassGrants).values({
      facilityId: c.facility.id,
      patientId,
      grantedTo: later.actor.membershipId,
      reason: "Yesterday's emergency",
      grantedAt: new Date(Date.now() - 13 * 3_600_000),
      expiresAt: new Date(Date.now() - 3_600_000),
    });
    expect((await c.read(encounterId, "notes", later)).restricted).toHaveLength(1);
  });
});

describe("restricted records, under review", () => {
  it("answer an addendum's author with the addendum alone once its note is restricted to them", async () => {
    const c = await clinic();
    const { encounterId } = await c.visit(c.gopd);
    const noteId = await c.note(encounterId);
    const addendum = await (await call("POST", `/notes/${noteId}/addenda`, c.facility.id, c.other, { text: "Seen again" })).json();
    // The author marks the note after the other doctor added to it.
    await call("POST", `/notes/${noteId}/sensitive`, c.facility.id, c.doctor, { category: "gbv" });

    expect((await call("POST", `/notes/${addendum.addenda[0].id}/entered-in-error`, c.facility.id, c.other, { reason: "Wrong patient" })).status).toBe(404);
  });

  it("record a diagnosis the same way whether or not a hidden one has its code or rank", async () => {
    const c = await clinic();
    const { encounterId } = await c.visit(c.gopd);
    await c.diagnose(encounterId, "1C62.Z");

    // To the other doctor the visit has no diagnosis: the same code is new to them, and theirs is the principal.
    const res = await call("POST", `/encounters/${encounterId}/diagnoses`, c.facility.id, c.other, { code: "1C62.Z", certainty: "provisional" });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ code: "1C62.Z", rank: "principal" });
  });

  it("alert whoever entered a walk-in's sensitive test", async () => {
    const c = await clinic();
    const hiv = await c.labTest("HIV", "hiv");
    const { encounterId, patientId } = await c.visit(null);
    expect((await call("POST", `/encounters/${encounterId}/walk-in-orders`, c.facility.id, c.labTech, { labTestIds: [hiv.testId], selfRequested: true })).status).toBe(201);

    await call("POST", `/patients/${patientId}/break-glass`, c.facility.id, c.other, { reason: "Emergency" });

    expect((await (await call("GET", "/break-glass", c.facility.id, c.labTech)).json()).breakGlass).toHaveLength(1);
  });

  it("mark a change made through a grant with it, and alert whoever recorded a record it opened later", async () => {
    const c = await clinic();
    const { encounterId, patientId } = await c.visit(c.gopd);
    const diagnosisId = await c.diagnose(encounterId, "1C62.Z");
    const noteId = await c.note(encounterId);
    // The grant is taken while the note is unmarked: its author is not alerted then.
    const grant = await (await call("POST", `/patients/${patientId}/break-glass`, c.facility.id, c.other, { reason: "Emergency" })).json();
    await call("POST", `/notes/${noteId}/sensitive`, c.facility.id, c.doctor, { category: "gbv" });
    const later = await c.person(["doctor"]);
    const laterNote = await c.note(encounterId, { plan: "Seen by another" }, later);
    await call("POST", `/notes/${laterNote}/sensitive`, c.facility.id, later, { category: "gbv" });
    expect((await (await call("GET", "/break-glass", c.facility.id, later)).json()).breakGlass).toEqual([]);

    // Confirming the hidden diagnosis through the grant answers with it: a read through the grant.
    expect((await call("POST", `/diagnoses/${diagnosisId}/confirm`, c.facility.id, c.other)).status).toBe(200);
    const marked = (await audits(c, "encounter.viewed", c.other.id)).filter(a => (a.detail as { breakGlassId?: string } | null)?.breakGlassId === grant.id);
    expect(marked).toHaveLength(1);
    // Reading the notes opens the later doctor's restricted note: they are told now.
    expect((await c.read(encounterId, "notes", c.other)).restricted).toEqual([]);
    expect((await (await call("GET", "/break-glass", c.facility.id, later)).json()).breakGlass.map((g: { id: string }) => g.id)).toEqual([grant.id]);
  });

  it("audit the grant a report was seen through, even on a page of results with none", async () => {
    const c = await clinic();
    const hiv = await c.labTest("HIV", "hiv");
    const { encounterId, patientId } = await c.visit(c.gopd);
    await resulted(c, encounterId, hiv);
    const grant = await (await call("POST", `/patients/${patientId}/break-glass`, c.facility.id, c.other, { reason: "Emergency" })).json();

    const page = await (await call("GET", `/encounters/${encounterId}/lab-results?offset=10`, c.facility.id, c.other)).json();

    expect([page.results, page.reports.length]).toEqual([[], 1]);
    expect((await audits(c, "encounter.viewed", c.other.id)).at(-1)?.detail).toEqual({ breakGlassId: grant.id });
  });
});

describe("marks and neutral names", () => {
  it("are kept by those who keep the clinic, the catalogue and the staff list, audited", async () => {
    const c = await clinic();
    const triage = (await (await call("POST", "/service-points", c.facility.id, c.admin, { name: "Triage", kind: "triage" })).json()).id;
    expect((await (await call("PATCH", `/service-points/${triage}`, c.facility.id, c.admin, { sensitiveCategory: "hiv" })).json()).code).toBe("not_a_clinic");
    expect((await call("PATCH", `/service-points/${c.ccc}`, c.facility.id, c.cccNurse, { sensitiveCategory: null })).status).toBe(403);

    const hiv = await c.labTest("HIV", "hiv");
    const unmarked = await call("PATCH", `/lab-tests/${hiv.testId}`, c.facility.id, c.supervisor, { sensitiveCategory: null });
    expect(await unmarked.json()).toMatchObject({ sensitiveCategory: null });

    const members = (await (await call("GET", "/staff/members", c.facility.id, c.admin)).json()).members;
    expect(members.find((m: { id: string }) => m.id === c.cccNurse.actor.membershipId).sensitiveCategories).toEqual(["hiv"]);
    expect((await audits(c, "membership.sensitive_access_changed"))[0].detail).toEqual({ from: [], to: ["hiv"] });
    expect((await call("PUT", `/staff/members/${c.cccNurse.actor.membershipId}/sensitive-access`, c.facility.id, c.cccNurse, { categories: [] })).status).toBe(403);
  });

  it("print a sensitive item under its neutral name, as it stood when the charge was captured", async () => {
    const c = await clinic();
    const hiv = await c.labTest("LAB-017");
    expect(await (await call("PUT", `/billable-items/${hiv.itemId}/printed-name`, c.facility.id, c.admin, { printedName: "Laboratory test" })).json())
      .toEqual({ id: hiv.itemId, printedName: "Laboratory test" });
    const { encounterId } = await c.visit(c.gopd);
    await call("POST", `/encounters/${encounterId}/orders`, c.facility.id, c.doctor, { items: [{ labTestId: hiv.testId }] });
    // Changed after capture: the charge keeps what it copied.
    await call("PUT", `/billable-items/${hiv.itemId}/printed-name`, c.facility.id, c.admin, { printedName: null });

    expect((await call("POST", `/encounters/${encounterId}/bill-now`, c.facility.id, c.cashier)).status).toBe(201);

    const [charge] = await db.select().from(charges).where(eq(charges.encounterId, encounterId));
    expect(charge.printedName).toBe("Laboratory test");
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.facilityId, c.facility.id));
    expect(lines.map(l => l.description)).toEqual(["Laboratory test"]);
    expect((await audits(c, "billable_item.updated")).map(a => a.detail)).toEqual([
      { printedName: { from: null, to: "Laboratory test" } },
      { printedName: { from: "Laboratory test", to: null } },
    ]);
  });
});

describe("the database's sensitivity guards", () => {
  it("keep a note's mark, a grant's review, its alerts and a charge's printed name", async () => {
    const c = await clinic();
    const { encounterId, patientId } = await c.visit(c.ccc);
    const noteId = await c.note(encounterId, { sensitiveCategory: "mental_health" });
    const grant = await (await call("POST", `/patients/${patientId}/break-glass`, c.facility.id, c.other, { reason: "Emergency" })).json();
    await call("POST", `/encounters/${encounterId}/orders`, c.facility.id, c.doctor, { items: [{ labTestId: (await c.labTest("FBC")).testId }] });
    const state = (q: Promise<unknown>) => q.then(() => "ok", (e: { constraint?: string; code?: string }) => e.constraint ?? e.code);

    expect(await state(pool.query("UPDATE clinical_notes SET sensitive_category = NULL WHERE id = $1", [noteId]))).toBe("23001");
    expect(await state(pool.query("UPDATE clinical_notes SET sensitive_category = 'hiv' WHERE id = $1", [noteId]))).toBe("23001");
    expect(await state(pool.query("UPDATE break_glass_grants SET reason = 'Other' WHERE id = $1", [grant.id]))).toBe("23001");
    expect(await state(pool.query("UPDATE break_glass_grants SET reviewed_at = now(), reviewed_by = granted_to WHERE id = $1", [grant.id]))).toBe("ok");
    expect(await state(pool.query("UPDATE break_glass_grants SET review_note = 'Later' WHERE id = $1", [grant.id]))).toBe("23001");
    expect(await state(pool.query("DELETE FROM break_glass_grants WHERE id = $1", [grant.id]))).toBe("23001");
    expect(await state(pool.query("DELETE FROM break_glass_alerts WHERE grant_id = $1", [grant.id]))).toBe("23001");
    expect(await state(pool.query("UPDATE charges SET printed_name = 'Other' WHERE encounter_id = $1", [encounterId]))).toBe("23001");
    expect(await state(pool.query(
      "INSERT INTO service_points (facility_id, name, kind, sensitive_category) VALUES ($1, 'Triage 2', 'triage', 'hiv')",
      [c.facility.id],
    ))).toBe("service_points_sensitive_at_a_clinic");
  });
});
