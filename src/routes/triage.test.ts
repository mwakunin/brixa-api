import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import db, { pool } from "@/db";
import { auditLog } from "@/db/schema";
import { addDays, businessDate } from "@/lib/dates";
import { addMembership, makeFacility, makeOnboardedFacility, resetDb, signedInUser } from "@/test/helpers";
import { call } from "@/test/hospital";

/** P3 slice 2: vital signs, allergies, and the triage priority that orders the clinic queues. */

type Roles = Parameters<typeof addMembership>[2];

async function clinic() {
  const facility = await makeOnboardedFacility();
  const person = async (roles: Roles, licence?: { number: string; expiresOn: string }) => {
    const user = await signedInUser();
    const membership = await addMembership(user.id, facility.id, roles, licence ? { licence } : {});
    return { ...user, actor: { userId: user.id, membershipId: membership.id } };
  };
  const admin = await person(["facility_admin"]);
  const clerk = await person(["records_clerk"]);
  const nurse = await person(["nurse"]);
  const doctor = await person(["doctor"]);
  const cashier = await person(["cashier"]);
  const pharmacist = await person(["pharmacist"]);

  const patient = async () => (await (await call("POST", "/patients", facility.id, clerk, {
    givenName: "Neema",
    familyName: "Achieng",
    sex: "female",
    dateOfBirth: "1985-03-12",
    noPhoneReason: "no_phone",
    noIdReason: "not_carried",
    confirmNotDuplicate: true,
  })).json()).id as string;

  const visit = async (body: Record<string, unknown> = {}) =>
    (await call("POST", "/encounters", facility.id, clerk, { patientId: await patient(), kind: "opd", queueAt: null, ...body })).json();

  const point = async (name: string, kind: "triage" | "consultation") =>
    (await (await call("POST", "/service-points", facility.id, admin, { name, kind })).json()).id as string;

  return { facility, person, admin, clerk, nurse, doctor, cashier, pharmacist, patient, visit, point };
}

type Clinic = Awaited<ReturnType<typeof clinic>>;
type Person = Clinic["nurse"];

const at = (c: Clinic, who: Person, method: string, path: string, body?: unknown) => call(method, path, c.facility.id, who, body);
const firstIssuePath = async (res: Response) => (await res.json()).error.issues[0].path;

beforeEach(async () => {
  await resetDb();
});

describe("vital signs", () => {
  it("are recorded as a set by a nurse, and read back with who took them", async () => {
    const c = await clinic();
    const visit = await c.visit();

    const res = await at(c, c.nurse, "POST", `/encounters/${visit.id}/observations`, {
      readings: [
        { code: "temperature", value: 37.2 },
        { code: "pulse", value: 88 },
        { code: "bp_systolic", value: 120 },
        { code: "bp_diastolic", value: 80 },
        { code: "weight", value: 64.5 },
      ],
    });

    expect(res.status).toBe(201);
    const recorded = (await res.json()).observations;
    expect(recorded).toHaveLength(5);
    expect(recorded).toContainEqual(expect.objectContaining({
      code: "temperature",
      label: "Temperature",
      value: 37.2,
      unit: "°C",
      recordedBy: { membershipId: c.nurse.actor.membershipId, name: expect.any(String) },
      enteredInError: null,
    }));

    const read = await (await at(c, c.doctor, "GET", `/encounters/${visit.id}/observations`)).json();
    expect(read.observations.map((o: { code: string }) => o.code).sort()).toEqual(["bp_diastolic", "bp_systolic", "pulse", "temperature", "weight"]);
    const viewed = await db.select().from(auditLog).where(and(eq(auditLog.action, "encounter.viewed"), eq(auditLog.actorId, c.doctor.id)));
    expect(viewed.map(v => v.summary)).toEqual(["Viewed vital signs (5)"]);
  });

  it("refuses a reading no patient could give, half a blood pressure, a sign twice, and a time outside the visit", async () => {
    const c = await clinic();
    const visit = await c.visit();
    const record = (body: unknown) => at(c, c.nurse, "POST", `/encounters/${visit.id}/observations`, body);

    const typo = await record({ readings: [{ code: "temperature", value: 367 }] });
    expect(typo.status).toBe(422);
    expect(await firstIssuePath(typo)).toEqual(["readings", 0, "value"]);
    expect((await record({ readings: [{ code: "bp_systolic", value: 120 }] })).status).toBe(422);
    expect((await record({ readings: [{ code: "pulse", value: 80 }, { code: "pulse", value: 82 }] })).status).toBe(422);
    // Systolic and diastolic swapped: each in range, the pair impossible.
    const swapped = await record({ readings: [{ code: "bp_systolic", value: 40 }, { code: "bp_diastolic", value: 200 }] });
    expect(swapped.status).toBe(422);
    expect(await firstIssuePath(swapped)).toEqual(["readings"]);
    // More precise than is stored (two decimals) would be rounded: refused, not changed.
    const fine = await record({ readings: [{ code: "temperature", value: 37.205 }] });
    expect(await firstIssuePath(fine)).toEqual(["readings", 0, "value"]);
    expect((await record({ readings: [{ code: "temperature", value: 37.25 }] })).status).toBe(201);

    const future = await record({ readings: [{ code: "pulse", value: 80 }], observedAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(future.status).toBe(422);
    expect(await firstIssuePath(future)).toEqual(["observedAt"]);
    const before = await record({ readings: [{ code: "pulse", value: 80 }], observedAt: new Date(Date.now() - 86_400_000).toISOString() });
    expect(await firstIssuePath(before)).toEqual(["observedAt"]);
  });

  it("marks a wrong reading entered in error, keeping it on the record", async () => {
    const c = await clinic();
    const visit = await c.visit();
    const [reading] = (await (await at(c, c.nurse, "POST", `/encounters/${visit.id}/observations`, { readings: [{ code: "weight", value: 6.45 }] })).json()).observations;

    const marked = await at(c, c.nurse, "POST", `/observations/${reading.id}/entered-in-error`, { reason: "Typed 6.45 for 64.5" });
    expect(marked.status).toBe(200);
    const again = await at(c, c.doctor, "POST", `/observations/${reading.id}/entered-in-error`, { reason: "Again" });
    expect((await again.json()).code).toBe("already_in_error");

    const [read] = (await (await at(c, c.nurse, "GET", `/encounters/${visit.id}/observations`)).json()).observations;
    expect(read).toMatchObject({ value: 6.45, enteredInError: { reason: "Typed 6.45 for 64.5" } });
  });

  it("are taken by licensed clinical staff on an open encounter, and read by clinical staff only", async () => {
    const c = await clinic();
    const visit = await c.visit();
    const readings = { readings: [{ code: "pulse", value: 80 }] };
    const lapsed = await c.person(["nurse"], { number: "NCK7", expiresOn: addDays(businessDate(), -1) });

    expect((await at(c, c.clerk, "POST", `/encounters/${visit.id}/observations`, readings)).status).toBe(403);
    expect((await (await at(c, lapsed, "POST", `/encounters/${visit.id}/observations`, readings)).json()).code).toBe("licence_expired");
    expect((await at(c, c.cashier, "GET", `/encounters/${visit.id}/observations`)).status).toBe(403);
    expect((await at(c, c.pharmacist, "GET", `/encounters/${visit.id}/observations`)).status).toBe(200);

    await at(c, c.clerk, "POST", `/encounters/${visit.id}/close`);
    const closed = await at(c, c.nurse, "POST", `/encounters/${visit.id}/observations`, readings);
    expect((await closed.json()).code).toBe("not_open");

    const other = await makeFacility();
    const stranger = await signedInUser();
    await addMembership(stranger.id, other.id, ["nurse"]);
    expect((await call("POST", `/encounters/${visit.id}/observations`, other.id, stranger, readings)).status).toBe(404);
  });

  it("keep a visit from being cancelled, until they are marked entered in error", async () => {
    const c = await clinic();
    const visit = await c.visit();
    const [reading] = (await (await at(c, c.nurse, "POST", `/encounters/${visit.id}/observations`, { readings: [{ code: "pulse", value: 80 }] })).json()).observations;
    const cancel = () => at(c, c.clerk, "POST", `/encounters/${visit.id}/cancel`, { reason: "Wrong patient" });

    const refused = await cancel();
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("has_clinical_records");

    await at(c, c.nurse, "POST", `/observations/${reading.id}/entered-in-error`, { reason: "Wrong patient's record" });
    expect((await cancel()).status).toBe(200);
  });

  it("keep a visit from being cancelled after its triage entry is finished", async () => {
    const c = await clinic();
    const triage = await c.point("Triage", "triage");
    const visit = await c.visit({ queueAt: triage });
    await at(c, c.nurse, "POST", `/queue-entries/${visit.queue.entryId}/serve`);
    await at(c, c.nurse, "POST", `/encounters/${visit.id}/observations`, { readings: [{ code: "temperature", value: 38.4 }] });
    await at(c, c.nurse, "POST", `/queue-entries/${visit.queue.entryId}/finish`, {});

    const refused = await at(c, c.clerk, "POST", `/encounters/${visit.id}/cancel`, { reason: "Opened in error" });

    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("has_clinical_records");
  });

  it("are guarded by the database: plausible values, marked never edited, never deleted", async () => {
    const c = await clinic();
    const visit = await c.visit();
    const [reading] = (await (await at(c, c.nurse, "POST", `/encounters/${visit.id}/observations`, { readings: [{ code: "pulse", value: 80 }] })).json()).observations;
    const state = (q: Promise<unknown>) => q.then(() => "ok", (e: { constraint?: string; code?: string }) => e.constraint ?? e.code);

    expect(await state(pool.query(
      `INSERT INTO observations (facility_id, encounter_id, code, value, observed_at, recorded_at, recorded_by)
       SELECT facility_id, encounter_id, 'temperature', 367, observed_at, recorded_at, recorded_by FROM observations WHERE id = $1`,
      [reading.id],
    ))).toBe("observations_value_plausible");
    expect(await state(pool.query("UPDATE observations SET value = 81 WHERE id = $1", [reading.id]))).toBe("23001");
    expect(await state(pool.query("UPDATE observations SET entered_in_error_at = now() WHERE id = $1", [reading.id]))).toBe("observations_error_complete");
    expect(await state(pool.query("DELETE FROM observations WHERE id = $1", [reading.id]))).toBe("23001");
  });
});

describe("allergies", () => {
  it("are recorded per patient, with 'no known allergies' standing until one is found", async () => {
    const c = await clinic();
    const patient = await c.patient();
    const record = (body: unknown, who: Person = c.nurse) => at(c, who, "POST", `/patients/${patient}/allergies`, body);
    const list = async (query = "") => (await (await at(c, c.doctor, "GET", `/patients/${patient}/allergies${query}`)).json()).allergies;

    expect(await list()).toEqual([]);
    const none = await (await record({ noKnownAllergies: true })).json();
    expect(none).toMatchObject({ category: "none_known", allergen: null });
    expect((await (await record({ noKnownAllergies: true })).json()).id).toBe(none.id);
    // Answered with the standing record, so a read of it: audited.
    const repeated = await db.select().from(auditLog).where(and(eq(auditLog.action, "patient.viewed"), eq(auditLog.actorId, c.nurse.id)));
    expect(repeated.map(r => r.summary)).toEqual(["Viewed allergies: no known allergies, already recorded"]);

    const penicillin = await record({ category: "drug", allergen: "Penicillin", reaction: "Rash", severity: "severe" }, c.pharmacist);
    expect(penicillin.status).toBe(201);
    // Ending "no known allergies" is a removal too, audited as one.
    const ended = await db.select().from(auditLog).where(and(eq(auditLog.action, "allergy.removed"), eq(auditLog.entityId, patient)));
    expect(ended).toEqual([expect.objectContaining({ actorId: c.pharmacist.id, detail: expect.objectContaining({ allergyId: none.id, category: "none_known", reason: "no_longer_applies" }) })]);
    expect(await list()).toEqual([expect.objectContaining({ category: "drug", allergen: "Penicillin", reaction: "Rash", severity: "severe" })]);
    expect(await list("?includeEnded=true")).toContainEqual(expect.objectContaining({ id: none.id, removalReason: "no_longer_applies" }));

    const refused = await record({ noKnownAllergies: true });
    expect((await refused.json()).code).toBe("has_allergies");
  });

  it("are removed once, as entered in error or no longer applying, and stay on the record", async () => {
    const c = await clinic();
    const patient = await c.patient();
    const allergy = await (await at(c, c.nurse, "POST", `/patients/${patient}/allergies`, { category: "food", allergen: "Groundnuts" })).json();

    const removed = await at(c, c.nurse, "POST", `/allergies/${allergy.id}/remove`, { reason: "entered_in_error" });
    expect(await removed.json()).toMatchObject({ removalReason: "entered_in_error", removedAt: expect.any(String) });
    expect((await (await at(c, c.nurse, "POST", `/allergies/${allergy.id}/remove`, { reason: "no_longer_applies" })).json()).code).toBe("already_removed");
    expect((await (await at(c, c.doctor, "GET", `/patients/${patient}/allergies`)).json()).allergies).toEqual([]);
  });

  it("are recorded by licensed clinical and pharmacy staff, and read by clinical staff", async () => {
    const c = await clinic();
    const patient = await c.patient();

    expect((await at(c, c.clerk, "POST", `/patients/${patient}/allergies`, { noKnownAllergies: true })).status).toBe(403);
    expect((await at(c, c.cashier, "GET", `/patients/${patient}/allergies`)).status).toBe(403);
    expect((await at(c, c.pharmacist, "POST", `/patients/${patient}/allergies`, { noKnownAllergies: true })).status).toBe(201);
    const viewed = await db.select().from(auditLog).where(and(eq(auditLog.action, "patient.viewed"), eq(auditLog.entityId, patient)));
    expect(viewed).toHaveLength(0);
    await at(c, c.doctor, "GET", `/patients/${patient}/allergies`);
    expect(await db.select().from(auditLog).where(and(eq(auditLog.action, "patient.viewed"), eq(auditLog.entityId, patient)))).toHaveLength(1);
  });

  it("are guarded by the database: one 'no known allergies', ended never edited, never deleted", async () => {
    const c = await clinic();
    const patient = await c.patient();
    const none = await (await at(c, c.nurse, "POST", `/patients/${patient}/allergies`, { noKnownAllergies: true })).json();
    const state = (q: Promise<unknown>) => q.then(() => "ok", (e: { constraint?: string; code?: string }) => e.constraint ?? e.code);
    const copy = (category: string, allergen: string | null) => pool.query(
      `INSERT INTO patient_allergies (facility_id, patient_id, category, allergen, recorded_at, recorded_by)
       SELECT facility_id, patient_id, $2, $3, now(), recorded_by FROM patient_allergies WHERE id = $1`,
      [none.id, category, allergen],
    );

    expect(await state(copy("none_known", null))).toBe("patient_allergies_one_none_known");
    expect(await state(copy("drug", null))).toBe("patient_allergies_allergen_unless_none_known");
    expect(await state(pool.query("UPDATE patient_allergies SET category = 'drug', allergen = 'X' WHERE id = $1", [none.id]))).toBe("23001");
    expect(await state(pool.query("DELETE FROM patient_allergies WHERE id = $1", [none.id]))).toBe("23001");
  });
});

describe("the triage priority", () => {
  /** A patient through triage at `priority`, then waiting at `clinic`. */
  async function triaged(c: Clinic, triage: string, clinicId: string, priority?: string) {
    const visit = await c.visit({ queueAt: triage });
    await at(c, c.nurse, "POST", `/queue-entries/${visit.queue.entryId}/serve`);
    const res = await at(c, c.nurse, "POST", `/queue-entries/${visit.queue.entryId}/finish`, { nextServicePointId: clinicId, priority });
    expect(res.status).toBe(200);
    return { visit, next: (await res.json()).next };
  }

  const order = async (c: Clinic, clinicId: string) =>
    (await (await at(c, c.doctor, "GET", `/service-points/${clinicId}/queue`)).json()).entries.map((e: { encounterId: string; priority: string | null }) => [e.encounterId, e.priority]);

  it("orders the clinic queue: emergency, urgent, then routine or untriaged, each by arrival", async () => {
    const c = await clinic();
    const triage = await c.point("Triage", "triage");
    const gopd = await c.point("General OPD", "consultation");
    const routine = await triaged(c, triage, gopd, "routine");
    const emergency = await triaged(c, triage, gopd, "emergency");
    const urgent = await triaged(c, triage, gopd, "urgent");
    const untriaged = await c.visit({ queueAt: gopd });

    expect(await order(c, gopd)).toEqual([
      [emergency.visit.id, "emergency"],
      [urgent.visit.id, "urgent"],
      [routine.visit.id, "routine"],
      [untriaged.id, null],
    ]);
  });

  it("is set by triage alone, and stays with the visit back at a clinic", async () => {
    const c = await clinic();
    const triage = await c.point("Triage", "triage");
    const gopd = await c.point("General OPD", "consultation");
    const { visit, next } = await triaged(c, triage, gopd, "urgent");

    await at(c, c.doctor, "POST", `/queue-entries/${next.id}/serve`);
    const refused = await at(c, c.doctor, "POST", `/queue-entries/${next.id}/finish`, { priority: "emergency" });
    expect((await refused.json()).code).toBe("priority_at_triage_only");
    await at(c, c.doctor, "POST", `/queue-entries/${next.id}/finish`, {});

    const back = await (await at(c, c.clerk, "POST", `/encounters/${visit.id}/queue`, { servicePointId: gopd })).json();
    expect(await order(c, gopd)).toEqual([[visit.id, "urgent"]]);

    // The database refuses a priority set anywhere but triage, for every role.
    await at(c, c.doctor, "POST", `/queue-entries/${back.id}/serve`);
    const state = (q: Promise<unknown>) => q.then(() => "ok", (e: { constraint?: string; code?: string }) => e.constraint ?? e.code);
    expect(await state(pool.query("UPDATE queue_entries SET status = 'done', ended_at = now(), ended_by = served_by, priority = 'routine' WHERE id = $1", [back.id]))).toBe("23514");
  });
});
