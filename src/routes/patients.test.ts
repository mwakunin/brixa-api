import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { MembershipRole } from "@/lib/types";

import app from "@/app";
import db from "@/db";
import { auditLog } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import { dateOfBirthForAge } from "@/lib/dates";
import { registerSeries } from "@/lib/number-series";
import { facilityHeaders, makeFacility, nextIp, resetDb, signedInUserAt } from "@/test/helpers";

type Person = Awaited<ReturnType<typeof signedInUserAt>>;

/** A facility with an OP series, as onboarding leaves it. */
async function facilityWithRegister() {
  const facility = await makeFacility();
  await runAsFacility(facility.id, tx => registerSeries(tx, {
    facilityId: facility.id,
    kind: "outpatient",
    prefix: "OP",
    resetPeriod: "never",
  }));
  return facility;
}

function call(method: string, path: string, facilityId: string, person: Person, body?: unknown) {
  return app.request(path, {
    method,
    headers: { ...facilityHeaders(facilityId, person), "content-type": "application/json", "x-forwarded-for": nextIp() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** A complete registration a clerk would send. */
function wanjiru(overrides: Record<string, unknown> = {}) {
  return {
    givenName: "Wanjiru",
    familyName: "Kamau",
    sex: "female",
    dateOfBirth: "1990-05-14",
    phone: "0712 345 678",
    identifiers: [{ type: "national_id", value: "12 345 678" }],
    ...overrides,
  };
}

function auditOf(action: string) {
  return db.select().from(auditLog).where(eq(auditLog.action, action as never));
}

describe("registering a patient", () => {
  let facility: Awaited<ReturnType<typeof facilityWithRegister>>;
  let clerk: Person;

  beforeEach(async () => {
    await resetDb();
    facility = await facilityWithRegister();
    clerk = await signedInUserAt(facility.id, ["records_clerk"]);
  });

  const register = (body: unknown, as = clerk) => call("POST", "/patients", facility.id, as, body);

  it("issues the OP number, stores the phone and ID one way, and audits it", async () => {
    const res = await register(wanjiru());

    expect(res.status).toBe(201);
    const patient = await res.json();
    expect(patient).toMatchObject({
      givenName: "Wanjiru",
      familyName: "Kamau",
      sex: "female",
      dateOfBirth: "1990-05-14",
      dobIsEstimated: false,
      phone: "+254712345678",
      noPhoneReason: null,
      noIdReason: null,
      numbers: [{ kind: "outpatient", number: "OP0001" }],
      identifiers: [{ type: "national_id", value: "12345678" }],
    });
    const [entry] = await auditOf("patient.registered");
    expect(entry).toMatchObject({ actorId: clerk.id, entityId: patient.id, summary: "Registered OP0001" });
    // The registration answer is not counted as someone opening the record.
    expect(await auditOf("patient.viewed")).toHaveLength(0);
  });

  it("takes an estimated age when the date of birth is not known", async () => {
    const res = await register(wanjiru({ dateOfBirth: undefined, estimatedAgeYears: 40 }));

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ dateOfBirth: dateOfBirthForAge(40), dobIsEstimated: true, age: 40 });
  });

  it.each([
    ["no phone and no reason", { phone: undefined }],
    ["no identity document and no reason", { identifiers: [] }],
    ["only an SHA number for an identity document", { identifiers: [{ type: "sha_number", value: "SHA123" }] }],
    ["no sex for an identified patient", { sex: null }],
    ["both a date of birth and an age", { estimatedAgeYears: 30 }],
    ["a date of birth in the future", { dateOfBirth: "2999-01-01" }],
    ["a phone that is not one", { phone: "12345" }],
    ["an 'unidentified' reason for someone identified", { phone: undefined, noPhoneReason: "unidentified" }],
  ])("refuses %s", async (_label, overrides) => {
    expect((await register(wanjiru(overrides))).status).toBe(422);
  });

  it("registers someone without a phone or ID, when the clerk says why", async () => {
    const res = await register(wanjiru({ phone: undefined, noPhoneReason: "no_phone", identifiers: [], noIdReason: "not_carried" }));

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ phone: null, noPhoneReason: "no_phone", noIdReason: "not_carried" });
  });

  it("registers an unidentified emergency patient, with no sex recorded yet", async () => {
    const res = await register({
      givenName: "Unknown",
      familyName: "Male",
      sex: null,
      estimatedAgeYears: 30,
      noPhoneReason: "unidentified",
      noIdReason: "unidentified",
      unidentified: true,
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ unidentified: true, sex: null, numbers: [{ number: "OP0001" }] });
  });

  it.each([
    ["the same ID number", { givenName: "Jane", familyName: "Otieno", phone: "0799000111" }, "same_id"],
    ["the same family name and phone", { givenName: "Jane", identifiers: [{ type: "national_id", value: "999" }] }, "same_name_and_phone"],
    ["the same names and date of birth", { phone: "0799000111", identifiers: [{ type: "passport", value: "A1" }] }, "same_name_and_birth_date"],
  ])("warns about a likely duplicate with %s, and registers once the clerk confirms", async (_label, overrides, reason) => {
    const first = await (await register(wanjiru())).json();

    const warned = await register(wanjiru(overrides));

    expect(warned.status).toBe(409);
    const body = await warned.json();
    expect(body.code).toBe("possible_duplicate");
    expect(body.candidates).toEqual([expect.objectContaining({ id: first.id, opNumber: "OP0001", reasons: [reason] })]);

    const confirmed = await register(wanjiru({ ...overrides, confirmNotDuplicate: true }));
    expect(confirmed.status).toBe(201);
    expect((await confirmed.json()).numbers[0].number).toBe("OP0002");
  });

  it("is for front-desk staff, nurses and the admin, not the cashier", async () => {
    const cashier = await signedInUserAt(facility.id, ["cashier"]);
    const nurse = await signedInUserAt(facility.id, ["nurse"]);

    expect((await register(wanjiru(), cashier)).status).toBe(403);
    expect((await register(wanjiru(), nurse)).status).toBe(201);
  });
});

describe("finding and opening a patient", () => {
  let facility: Awaited<ReturnType<typeof facilityWithRegister>>;
  let clerk: Person;
  let patient: { id: string };

  beforeEach(async () => {
    await resetDb();
    facility = await facilityWithRegister();
    clerk = await signedInUserAt(facility.id, ["records_clerk"]);
    patient = await (await call("POST", "/patients", facility.id, clerk, wanjiru({ middleNames: "Njeri" }))).json();
  });

  async function search(q: string, as: Person = clerk) {
    const res = await call("GET", `/patients?q=${encodeURIComponent(q)}`, facility.id, as);
    return { status: res.status, ids: res.status === 200 ? (await res.json()).patients.map((p: { id: string }) => p.id) : [] };
  }

  it.each([
    ["the OP number, in any case", "op0001"],
    ["the phone, typed another way", "+254 712 345 678"],
    ["the ID number, with spaces", "12 345 678"],
    ["the start of two names", "wan kam"],
    ["a middle name", "Njeri"],
  ])("finds them by %s", async (_label, q) => {
    expect((await search(q)).ids).toEqual([patient.id]);
  });

  it("finds nobody for a name that is not on file", async () => {
    expect((await search("Otieno")).ids).toEqual([]);
  });

  it("treats LIKE wildcards in a search as letters", async () => {
    expect((await search("%%")).ids).toEqual([]);
  });

  it("records each search, with what was searched for", async () => {
    await search("Kamau");

    const [entry] = await auditOf("patient.searched");
    expect(entry).toMatchObject({ actorId: clerk.id, detail: { query: "Kamau", results: 1 } });
  });

  it("lets any member find and open a record, and records each opening", async () => {
    const cashier = await signedInUserAt(facility.id, ["cashier"]);
    expect((await search("Kamau", cashier)).ids).toEqual([patient.id]);

    const res = await call("GET", `/patients/${patient.id}`, facility.id, cashier);

    expect(res.status).toBe(200);
    const [entry] = await auditOf("patient.viewed");
    expect(entry).toMatchObject({ actorId: cashier.id, entityId: patient.id });
  });

  it("keeps another facility's register out of reach", async () => {
    const elsewhere = await facilityWithRegister();
    const theirClerk = await signedInUserAt(elsewhere.id, ["records_clerk"]);

    const found = await call("GET", "/patients?q=Kamau", elsewhere.id, theirClerk);
    expect((await found.json()).patients).toEqual([]);
    expect((await call("GET", `/patients/${patient.id}`, elsewhere.id, theirClerk)).status).toBe(404);
  });

  it("refuses a search too short to mean anything", async () => {
    expect((await search("k")).status).toBe(422);
  });

  it("limits how fast one person can search", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 61; i += 1)
      statuses.push((await search("Kamau")).status);

    expect(statuses.slice(0, 60).every(s => s === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
  });
});

describe("correcting a patient's details", () => {
  let facility: Awaited<ReturnType<typeof facilityWithRegister>>;
  let clerk: Person;

  beforeEach(async () => {
    await resetDb();
    facility = await facilityWithRegister();
    clerk = await signedInUserAt(facility.id, ["records_clerk"]);
  });

  async function registered(body: unknown) {
    return (await call("POST", "/patients", facility.id, clerk, body)).json();
  }

  const patch = (id: string, body: unknown, as: Person = clerk) => call("PATCH", `/patients/${id}`, facility.id, as, body);

  it("records each changed field's old and new value", async () => {
    const patient = await registered(wanjiru());

    const res = await patch(patient.id, { familyName: "Kamau-Otieno", phone: "0722 000 111" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ familyName: "Kamau-Otieno", phone: "+254722000111" });
    const [entry] = await auditOf("patient.updated");
    expect(entry.detail).toEqual({
      familyName: { from: "Kamau", to: "Kamau-Otieno" },
      phone: { from: "+254712345678", to: "+254722000111" },
    });
  });

  it("removes the old phone when told there is none any more", async () => {
    const patient = await registered(wanjiru());

    const res = await patch(patient.id, { noPhoneReason: "no_phone" });

    expect(await res.json()).toMatchObject({ phone: null, noPhoneReason: "no_phone" });
  });

  it("identifies an unidentified patient only once their missing details are explained", async () => {
    const patient = await registered({
      givenName: "Unknown",
      familyName: "Female",
      sex: null,
      estimatedAgeYears: 25,
      noPhoneReason: "unidentified",
      noIdReason: "unidentified",
      unidentified: true,
    });

    const tooSoon = await patch(patient.id, { givenName: "Achieng", familyName: "Otieno", sex: "female", unidentified: false });
    expect(tooSoon.status).toBe(422);
    expect(JSON.stringify(await tooSoon.json())).toContain("'unidentified' reason");

    const done = await patch(patient.id, {
      givenName: "Achieng",
      familyName: "Otieno",
      sex: "female",
      unidentified: false,
      phone: "0733 111 222",
      noIdReason: "not_carried",
    });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ unidentified: false, givenName: "Achieng", noIdReason: "not_carried" });
  });

  it("adds an ID number, clearing the reason there was none", async () => {
    const patient = await registered(wanjiru({ identifiers: [], noIdReason: "not_carried" }));

    const res = await call("POST", `/patients/${patient.id}/identifiers`, facility.id, clerk, { type: "national_id", value: "87654321" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ noIdReason: null, identifiers: [{ type: "national_id", value: "87654321" }] });
    expect(await db.select().from(auditLog).where(and(
      eq(auditLog.action, "patient.identifier_added"),
      eq(auditLog.entityId, patient.id),
    ))).toHaveLength(1);
  });

  it("adds an ID number already on file without a second audit entry", async () => {
    const patient = await registered(wanjiru({ identifiers: [], noIdReason: "not_carried" }));
    const add = () => call("POST", `/patients/${patient.id}/identifiers`, facility.id, clerk, { type: "national_id", value: "87654321" });

    await add();
    expect((await add()).status).toBe(200);

    expect(await auditOf("patient.identifier_added")).toHaveLength(1);
  });

  it("keeps the reason there is no ID until an ID is on file", async () => {
    const patient = await registered(wanjiru({ identifiers: [], noIdReason: "not_carried" }));

    const res = await patch(patient.id, { noIdReason: null });

    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("identity document");
  });

  it("warns before adding an ID number another patient already has", async () => {
    const holder = await registered(wanjiru());
    const other = await registered(wanjiru({
      givenName: "Jane",
      familyName: "Otieno",
      phone: "0799000111",
      identifiers: [],
      noIdReason: "not_carried",
    }));

    const warned = await call("POST", `/patients/${other.id}/identifiers`, facility.id, clerk, { type: "national_id", value: "12345678" });

    expect(warned.status).toBe(409);
    expect((await warned.json()).candidates.map((p: { id: string }) => p.id)).toEqual([holder.id]);
  });

  it("is not for the cashier", async () => {
    const patient = await registered(wanjiru());
    const cashier = await signedInUserAt(facility.id, ["cashier"] as MembershipRole[]);

    expect((await patch(patient.id, { familyName: "Otieno" }, cashier)).status).toBe(403);
  });
});
