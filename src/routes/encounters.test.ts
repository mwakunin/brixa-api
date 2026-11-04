import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import app from "@/app";
import db, { pool } from "@/db";
import { auditLog } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import { registerSeries } from "@/lib/number-series";
import { facilityHeaders, makeFacility, nextIp, resetDb, signedInUserAt } from "@/test/helpers";

type Person = Awaited<ReturnType<typeof signedInUserAt>>;

const YEAR = new Date().getUTCFullYear();

/** A facility with the series onboarding registers. */
async function facilityReady() {
  const facility = await makeFacility();
  await runAsFacility(facility.id, async (tx) => {
    await registerSeries(tx, { facilityId: facility.id, kind: "outpatient", prefix: "OP", resetPeriod: "never" });
    await registerSeries(tx, { facilityId: facility.id, kind: "inpatient", prefix: "IP", resetPeriod: "never" });
    await registerSeries(tx, { facilityId: facility.id, kind: "admission", prefix: "ADM-", resetPeriod: "yearly" });
  });
  return facility;
}

function call(method: string, path: string, facilityId: string, person: Person, body?: unknown) {
  return app.request(path, {
    method,
    headers: { ...facilityHeaders(facilityId, person), "content-type": "application/json", "x-forwarded-for": nextIp() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

let patientCounter = 0;

async function registered(facilityId: string, clerk: Person): Promise<string> {
  patientCounter += 1;
  const res = await call("POST", "/patients", facilityId, clerk, {
    givenName: "Patient",
    familyName: `Number${patientCounter}`,
    sex: "female",
    dateOfBirth: "1990-01-01",
    noPhoneReason: "no_phone",
    noIdReason: "not_carried",
    confirmNotDuplicate: true,
  });
  return (await res.json()).id;
}

function auditOf(action: string) {
  return db.select().from(auditLog).where(eq(auditLog.action, action as never));
}

describe("wards and beds", () => {
  let facility: Awaited<ReturnType<typeof facilityReady>>;
  let admin: Person;

  beforeEach(async () => {
    await resetDb();
    facility = await facilityReady();
    admin = await signedInUserAt(facility.id, ["facility_admin"]);
  });

  it("are set up by the facility admin, and listed for everyone", async () => {
    const ward = await (await call("POST", "/wards", facility.id, admin, { name: "Female Medical" })).json();
    expect((await call("POST", `/wards/${ward.id}/beds`, facility.id, admin, { label: "B1" })).status).toBe(201);
    const nurse = await signedInUserAt(facility.id, ["nurse"]);

    const res = await call("GET", "/wards", facility.id, nurse);

    expect(await res.json()).toEqual({
      wards: [{ id: ward.id, name: "Female Medical", isActive: true, beds: [expect.objectContaining({ label: "B1", occupied: false })] }],
    });
  });

  it("refuse a second ward of the same name, or a second bed of the same label", async () => {
    const ward = await (await call("POST", "/wards", facility.id, admin, { name: "Maternity" })).json();
    await call("POST", `/wards/${ward.id}/beds`, facility.id, admin, { label: "M1" });

    expect((await call("POST", "/wards", facility.id, admin, { name: "Maternity" })).status).toBe(409);
    expect((await call("POST", `/wards/${ward.id}/beds`, facility.id, admin, { label: "M1" })).status).toBe(409);
  });

  it("are not set up by a nurse", async () => {
    const nurse = await signedInUserAt(facility.id, ["nurse"]);

    expect((await call("POST", "/wards", facility.id, nurse, { name: "Paediatric" })).status).toBe(403);
  });
});

describe("visits", () => {
  let facility: Awaited<ReturnType<typeof facilityReady>>;
  let clerk: Person;
  let patientId: string;

  beforeEach(async () => {
    await resetDb();
    facility = await facilityReady();
    clerk = await signedInUserAt(facility.id, ["records_clerk"]);
    patientId = await registered(facility.id, clerk);
  });

  const open = (kind = "opd") => call("POST", "/encounters", facility.id, clerk, { patientId, kind });

  it("open, close, and are audited", async () => {
    const opened = await open();
    expect(opened.status).toBe(201);
    const visit = await opened.json();
    expect(visit).toMatchObject({ kind: "opd", status: "open", endedAt: null, admission: null });

    const closed = await call("POST", `/encounters/${visit.id}/close`, facility.id, clerk);

    expect(await closed.json()).toMatchObject({ status: "closed", endedAt: expect.any(String) });
    expect(await auditOf("encounter.opened")).toHaveLength(1);
    expect(await auditOf("encounter.closed")).toHaveLength(1);
  });

  it("allow one open visit of each kind per patient", async () => {
    await open("opd");

    expect((await open("opd")).status).toBe(409);
    expect((await open("emergency")).status).toBe(201);
  });

  it("can be cancelled with a reason, and then not closed", async () => {
    const visit = await (await open()).json();

    const cancelled = await call("POST", `/encounters/${visit.id}/cancel`, facility.id, clerk, { reason: "Opened for the wrong patient" });

    expect(await cancelled.json()).toMatchObject({ status: "cancelled", cancelReason: "Opened for the wrong patient" });
    expect((await call("POST", `/encounters/${visit.id}/close`, facility.id, clerk)).status).toBe(409);
  });

  it("are audited when read, singly and as a patient's list", async () => {
    const visit = await (await open()).json();

    await call("GET", `/encounters/${visit.id}`, facility.id, clerk);
    const list = await call("GET", `/encounters?patientId=${patientId}`, facility.id, clerk);

    expect((await list.json()).encounters.map((e: { id: string }) => e.id)).toEqual([visit.id]);
    expect(await auditOf("encounter.viewed")).toHaveLength(2);
  });

  it("stay within their facility", async () => {
    const visit = await (await open()).json();
    const elsewhere = await facilityReady();
    const theirClerk = await signedInUserAt(elsewhere.id, ["records_clerk"]);

    expect((await call("GET", `/encounters/${visit.id}`, elsewhere.id, theirClerk)).status).toBe(404);
  });
});

describe("admissions", () => {
  let facility: Awaited<ReturnType<typeof facilityReady>>;
  let nurse: Person;
  let bedIds: string[];

  beforeEach(async () => {
    await resetDb();
    facility = await facilityReady();
    nurse = await signedInUserAt(facility.id, ["nurse"]);
    const admin = await signedInUserAt(facility.id, ["facility_admin"]);
    const ward = await (await call("POST", "/wards", facility.id, admin, { name: "Male Surgical" })).json();
    bedIds = [];
    for (const label of ["S1", "S2"])
      bedIds.push((await (await call("POST", `/wards/${ward.id}/beds`, facility.id, admin, { label })).json()).id);
  });

  const admit = (patientId: string, bedId: string, extra: Record<string, unknown> = {}) =>
    call("POST", "/admissions", facility.id, nurse, { patientId, bedId, ...extra });

  async function occupied() {
    const { wards } = await (await call("GET", "/wards", facility.id, nurse)).json();
    return wards[0].beds.map((b: { occupied: boolean }) => b.occupied);
  }

  it("place the patient in a bed, with an IP number and an admission number", async () => {
    const patientId = await registered(facility.id, nurse);

    const res = await admit(patientId, bedIds[0]);

    expect(res.status).toBe(201);
    const admission = await res.json();
    expect(admission).toMatchObject({
      kind: "ipd",
      status: "open",
      admission: { admissionNumber: `ADM-${YEAR}-0001`, stays: [{ bedId: bedIds[0], bedLabel: "S1", wardName: "Male Surgical", endedAt: null }] },
    });
    const patient = await (await call("GET", `/patients/${patientId}`, facility.id, nurse)).json();
    expect(patient.numbers.map((n: { number: string }) => n.number)).toEqual(["OP0001", "IP0001"]);
    expect(await occupied()).toEqual([true, false]);
  });

  it("keep the IP number for life, with a new admission number each time", async () => {
    const patientId = await registered(facility.id, nurse);
    const first = await (await admit(patientId, bedIds[0])).json();
    await call("POST", `/encounters/${first.id}/discharge`, facility.id, nurse, { disposition: "home" });

    const second = await (await admit(patientId, bedIds[1])).json();

    expect(second.admission.admissionNumber).toBe(`ADM-${YEAR}-0002`);
    const patient = await (await call("GET", `/patients/${patientId}`, facility.id, nurse)).json();
    expect(patient.numbers.filter((n: { kind: string }) => n.kind === "inpatient")).toHaveLength(1);
  });

  it("refuse a patient already admitted, and a bed already taken", async () => {
    const [a, b] = [await registered(facility.id, nurse), await registered(facility.id, nurse)];
    await admit(a, bedIds[0]);

    const again = await admit(a, bedIds[1]);
    const taken = await admit(b, bedIds[0]);

    expect([again.status, (await again.json()).code]).toEqual([409, "already_admitted"]);
    expect([taken.status, (await taken.json()).code]).toEqual([409, "bed_occupied"]);
  });

  it("give one bed to only one of two patients admitted to it at once", async () => {
    const [a, b] = [await registered(facility.id, nurse), await registered(facility.id, nurse)];

    const results = await Promise.all([admit(a, bedIds[0]), admit(b, bedIds[0])]);

    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    expect(await occupied()).toEqual([true, false]);
  });

  it("link an admission to the visit it followed, but only the same patient's", async () => {
    const [a, b] = [await registered(facility.id, nurse), await registered(facility.id, nurse)];
    const visit = await (await call("POST", "/encounters", facility.id, nurse, { patientId: a, kind: "emergency" })).json();

    expect((await admit(b, bedIds[0], { parentEncounterId: visit.id })).status).toBe(409);
    expect((await (await admit(a, bedIds[0], { parentEncounterId: visit.id })).json()).parentEncounterId).toBe(visit.id);
  });

  it("move a patient: one stay ends as the next begins", async () => {
    const patientId = await registered(facility.id, nurse);
    const admission = await (await admit(patientId, bedIds[0])).json();

    const moved = await (await call("POST", `/encounters/${admission.id}/transfer`, facility.id, nurse, { bedId: bedIds[1] })).json();

    const [left, entered] = moved.admission.stays;
    expect(left).toMatchObject({ bedLabel: "S1", endedAt: expect.any(String) });
    expect(entered).toMatchObject({ bedLabel: "S2", endedAt: null, startedAt: left.endedAt });
    expect(await occupied()).toEqual([false, true]);
    expect((await call("POST", `/encounters/${admission.id}/transfer`, facility.id, nurse, { bedId: bedIds[1] })).status).toBe(409);
  });

  it("end by discharge, which frees the bed and closes the encounter", async () => {
    const patientId = await registered(facility.id, nurse);
    const admission = await (await admit(patientId, bedIds[0])).json();
    expect((await call("POST", `/encounters/${admission.id}/close`, facility.id, nurse)).status).toBe(409);

    const discharged = await (await call("POST", `/encounters/${admission.id}/discharge`, facility.id, nurse, { disposition: "referred" })).json();

    expect(discharged).toMatchObject({
      status: "closed",
      admission: { dischargeDisposition: "referred", dischargedAt: expect.any(String), stays: [{ endedAt: expect.any(String) }] },
    });
    expect(await occupied()).toEqual([false, false]);
    expect(await auditOf("patient.discharged")).toHaveLength(1);
  });

  it("are not made by the cashier", async () => {
    const patientId = await registered(facility.id, nurse);
    const cashier = await signedInUserAt(facility.id, ["cashier"]);

    expect((await call("POST", "/admissions", facility.id, cashier, { patientId, bedId: bedIds[0] })).status).toBe(403);
  });
});

describe("the bed rules, in the database itself", () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function admitted() {
    const facility = await facilityReady();
    const nurse = await signedInUserAt(facility.id, ["nurse", "facility_admin"]);
    const ward = await (await call("POST", "/wards", facility.id, nurse, { name: "General" })).json();
    const bed = await (await call("POST", `/wards/${ward.id}/beds`, facility.id, nurse, { label: "G1" })).json();
    const patientId = await registered(facility.id, nurse);
    const admission = await (await call("POST", "/admissions", facility.id, nurse, { patientId, bedId: bed.id })).json();
    const { rows: [stay] } = await pool.query("SELECT * FROM bed_stays LIMIT 1");
    return { facility, bed, admission, stay };
  }

  it("refuse a second stay in an occupied bed, even from the owner", async () => {
    const { stay } = await admitted();

    const overlap = pool.query(
      "INSERT INTO bed_stays (facility_id, admission_id, bed_id, started_at, started_by) VALUES ($1, $2, $3, now(), $4)",
      [stay.facility_id, stay.admission_id, stay.bed_id, stay.started_by],
    );

    await expect(overlap).rejects.toMatchObject({ code: "23P01" });
  });

  it("refuse to reopen a stay that has ended", async () => {
    const { facility, admission, stay } = await admitted();
    const nurse = await signedInUserAt(facility.id, ["nurse"]);
    await call("POST", `/encounters/${admission.id}/discharge`, facility.id, nurse, { disposition: "home" });

    const reopen = pool.query("UPDATE bed_stays SET ended_at = NULL, ended_by = NULL WHERE id = $1", [stay.id]);

    await expect(reopen).rejects.toMatchObject({ code: "23001" });
  });
});
