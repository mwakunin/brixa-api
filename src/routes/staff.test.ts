import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import app from "@/app";
import db, { pool } from "@/db";
import { auditLog, memberships } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import { addDays, businessDate } from "@/lib/dates";
import { changeRoles } from "@/lib/practitioners";
import { addMembership, backendPid, facilityHeaders, makeFacility, resetDb, signedInUser, signedInUserAt, waitForBlockedBackend } from "@/test/helpers";

type Person = Awaited<ReturnType<typeof signedInUserAt>>;
type Licence = NonNullable<NonNullable<Parameters<typeof addMembership>[3]>["licence"]>;

function members(facilityId: string, person: Person) {
  return app.request("/staff/members", { headers: facilityHeaders(facilityId, person) });
}

function put(path: string, facilityId: string, person: Person, body: unknown) {
  return app.request(path, {
    method: "PUT",
    headers: { ...facilityHeaders(facilityId, person), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function renew(facilityId: string, person: Person, membershipId: string, body: unknown) {
  return put(`/staff/members/${membershipId}/licence`, facilityId, person, body);
}

function setRoles(facilityId: string, person: Person, membershipId: string, body: unknown) {
  return put(`/staff/members/${membershipId}/roles`, facilityId, person, body);
}

/** A member of `facilityId` holding `roles`, with the licence given (or the helper's default). */
async function memberWith(facilityId: string, roles: Parameters<typeof addMembership>[2], licence?: Licence) {
  const person = await signedInUser();
  return addMembership(person.id, facilityId, roles, licence ? { licence } : {});
}

/** The facility admin, with their membership id. */
async function adminOf(facilityId: string) {
  const person = await signedInUser();
  const membership = await addMembership(person.id, facilityId, ["facility_admin"]);
  return { ...person, membershipId: membership.id };
}

async function stored(membershipId: string) {
  const [row] = await db.select().from(memberships).where(eq(memberships.id, membershipId));
  return row;
}

describe("the facility admin's staff list", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("shows each member's licence, its council, and whether it is about to lapse", async () => {
    const facility = await makeFacility();
    const admin = await signedInUserAt(facility.id, ["facility_admin"]);
    const today = businessDate();
    const doctor = await memberWith(facility.id, ["doctor", "facility_admin"], { number: "A1234", expiresOn: addDays(today, 31) });
    const nurse = await memberWith(facility.id, ["ward_nurse", "pharm_tech"], { profession: "nurse", number: "NCK1", expiresOn: addDays(today, 30) });
    const lab = await memberWith(facility.id, ["lab_supervisor"], { number: "KMLTTB9", expiresOn: addDays(today, -1) });
    const cashier = await memberWith(facility.id, ["cashier"]);

    const res = await members(facility.id, admin);

    expect(res.status).toBe(200);
    const byId = new Map((await res.json()).members.map((m: { id: string }) => [m.id, m]));
    expect(byId.get(doctor.id)).toMatchObject({
      roles: ["doctor", "facility_admin"],
      licence: {
        profession: "medical_practitioner",
        council: "KMPDC",
        councilName: "Kenya Medical Practitioners and Dentists Council",
        number: "A1234",
        expiresOn: addDays(today, 31),
        state: "valid",
      },
    });
    expect(byId.get(nurse.id)).toMatchObject({ licence: { profession: "nurse", council: "NCK", state: "expiring" } });
    expect(byId.get(lab.id)).toMatchObject({ licence: { council: "KMLTTB", state: "expired" } });
    expect(byId.get(cashier.id)).toMatchObject({ licence: null });
    expect(byId.size).toBe(5);
  });

  it("is the facility admin's, and lists only this facility's active staff", async () => {
    const facility = await makeFacility();
    const other = await makeFacility();
    const admin = await signedInUserAt(facility.id, ["facility_admin"]);
    const nurse = await signedInUserAt(facility.id, ["nurse"]);
    const elsewhere = await memberWith(other.id, ["doctor"]);
    const former = await signedInUser();
    const left = await addMembership(former.id, facility.id, ["cashier"], { isActive: false });

    expect((await members(facility.id, nurse)).status).toBe(403);

    const ids = (await (await members(facility.id, admin)).json()).members.map((m: { id: string }) => m.id);
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain(elsewhere.id);
    expect(ids).not.toContain(left.id);
  });
});

describe("renewing a licence", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("records the renewed licence and audits the old and the new", async () => {
    const facility = await makeFacility();
    const admin = await signedInUserAt(facility.id, ["facility_admin"]);
    const old = { number: "RCO/1234", expiresOn: addDays(businessDate(), 5) };
    const officer = await memberWith(facility.id, ["clinical_officer"], old);
    const renewed = { number: "rco/1234", expiresOn: addDays(businessDate(), 370) };

    const res = await renew(facility.id, admin, officer.id, renewed);

    expect(res.status).toBe(200);
    expect((await res.json()).licence).toMatchObject({ profession: "clinical_officer", council: "COC", number: "RCO/1234", expiresOn: renewed.expiresOn, state: "valid" });
    const [entry] = await db.select().from(auditLog).where(and(eq(auditLog.action, "membership.licence_changed"), eq(auditLog.entityId, officer.id)));
    expect(entry.detail).toEqual({
      before: { profession: "clinical_officer", ...old },
      after: { profession: "clinical_officer", number: "RCO/1234", expiresOn: renewed.expiresOn },
    });
  });

  it("refuses a member with no clinical role, a licence already lapsed, and another facility's member", async () => {
    const facility = await makeFacility();
    const other = await makeFacility();
    const admin = await signedInUserAt(facility.id, ["facility_admin"]);
    const cashier = await memberWith(facility.id, ["cashier"]);
    const nurse = await memberWith(facility.id, ["nurse"]);
    const elsewhere = await memberWith(other.id, ["nurse"]);
    const licence = { number: "NCK77", expiresOn: addDays(businessDate(), 100) };

    const notClinical = await renew(facility.id, admin, cashier.id, licence);
    expect(notClinical.status).toBe(409);
    expect((await notClinical.json()).code).toBe("not_clinical");

    const lapsed = await renew(facility.id, admin, nurse.id, { ...licence, expiresOn: addDays(businessDate(), -1) });
    expect(lapsed.status).toBe(422);
    expect((await lapsed.json()).error.issues[0].path).toEqual(["expiresOn"]);

    expect((await renew(facility.id, admin, elsewhere.id, licence)).status).toBe(404);
    expect((await stored(elsewhere.id)).licenceNumber).toBe("TEST-0001");
  });

  it("is the facility admin's alone", async () => {
    const facility = await makeFacility();
    const doctor = await signedInUserAt(facility.id, ["doctor"]);
    const nurse = await memberWith(facility.id, ["nurse"]);

    const res = await renew(facility.id, doctor, nurse.id, { number: "NCK1", expiresOn: addDays(businessDate(), 100) });

    expect(res.status).toBe(403);
  });
});

describe("changing a member's roles", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("replaces the roles and audits the old and the new", async () => {
    const facility = await makeFacility();
    const admin = await adminOf(facility.id);
    const clerk = await memberWith(facility.id, ["records_clerk"]);

    const res = await setRoles(facility.id, admin, clerk.id, { roles: ["records_clerk", "cashier"] });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: clerk.id, roles: ["records_clerk", "cashier"], licence: null });
    const [entry] = await db.select().from(auditLog).where(and(eq(auditLog.action, "membership.roles_changed"), eq(auditLog.entityId, clerk.id)));
    expect(entry.detail).toEqual({
      before: { roles: ["records_clerk"], licence: null },
      after: { roles: ["records_clerk", "cashier"], licence: null },
    });
  });

  it("needs a licence to gain a clinical role, keeps one already held, and clears it with the last clinical role", async () => {
    const facility = await makeFacility();
    const admin = await adminOf(facility.id);
    const member = await memberWith(facility.id, ["cashier"]);
    const licence = { number: "NCK900", expiresOn: addDays(businessDate(), 200) };

    const without = await setRoles(facility.id, admin, member.id, { roles: ["nurse"] });
    expect(without.status).toBe(422);
    expect((await without.json()).error.issues[0].path).toEqual(["licence"]);

    const nurse = await setRoles(facility.id, admin, member.id, { roles: ["nurse"], licence });
    expect((await nurse.json()).licence).toMatchObject({ profession: "nurse", number: "NCK900" });

    // A pharmacy role at night, under the nursing licence already on record.
    const dispensing = await setRoles(facility.id, admin, member.id, { roles: ["nurse", "pharm_tech"] });
    expect(dispensing.status).toBe(200);
    expect((await dispensing.json()).licence).toMatchObject({ profession: "nurse", number: "NCK900" });

    const back = await setRoles(facility.id, admin, member.id, { roles: ["cashier"] });
    expect((await back.json()).licence).toBeNull();
    expect(await stored(member.id)).toMatchObject({ roles: ["cashier"], licenceProfession: null, licenceNumber: null, licenceExpiresOn: null });
  });

  it("needs a new licence when the roles no longer fit the one on record", async () => {
    const facility = await makeFacility();
    const admin = await adminOf(facility.id);
    const nurse = await memberWith(facility.id, ["nurse"], { number: "NCK1", expiresOn: addDays(businessDate(), 200) });

    const keptNursing = await setRoles(facility.id, admin, nurse.id, { roles: ["doctor"] });
    expect(keptNursing.status).toBe(422);
    expect((await keptNursing.json()).error.issues[0].path).toEqual(["licence"]);
    const wrongProfession = await setRoles(facility.id, admin, nurse.id, { roles: ["doctor"], licence: { profession: "nurse", number: "NCK1", expiresOn: addDays(businessDate(), 200) } });
    expect((await wrongProfession.json()).error.issues[0].path).toEqual(["licence", "profession"]);

    const doctor = await setRoles(facility.id, admin, nurse.id, { roles: ["doctor"], licence: { number: "A777", expiresOn: addDays(businessDate(), 200) } });
    expect((await doctor.json()).licence).toMatchObject({ profession: "medical_practitioner", council: "KMPDC", number: "A777" });
  });

  it("never leaves the facility without an admin", async () => {
    const facility = await makeFacility();
    const admin = await adminOf(facility.id);

    const alone = await setRoles(facility.id, admin, admin.membershipId, { roles: ["cashier"] });
    expect(alone.status).toBe(409);
    expect((await alone.json()).code).toBe("last_admin");

    const second = await memberWith(facility.id, ["finance_manager"]);
    expect((await setRoles(facility.id, admin, second.id, { roles: ["finance_manager", "facility_admin"] })).status).toBe(200);
    expect((await setRoles(facility.id, admin, admin.membershipId, { roles: ["cashier"] })).status).toBe(200);
  });

  it("refuses the second of two admins demoting each other at once", async () => {
    const facility = await makeFacility();
    const a = await memberWith(facility.id, ["facility_admin"]);
    const b = await memberWith(facility.id, ["facility_admin"]);

    let release!: () => void;
    let ready!: () => void;
    const mayCommit = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let holderPid = 0;
    const first = runAsFacility(facility.id, async (tx) => {
      try {
        await changeRoles(tx, facility.id, b.id, { roles: ["cashier"] }, { userId: a.userId });
        holderPid = await backendPid(tx);
      }
      finally {
        ready();
      }
      await mayCommit;
    });
    await started;

    const second = runAsFacility(facility.id, tx => changeRoles(tx, facility.id, a.id, { roles: ["cashier"] }, { userId: b.userId }));
    const outcome = second.then(() => "changed", (err: { code?: string }) => err.code);
    expect(await waitForBlockedBackend(holderPid)).toBe(true);
    release();
    await first;

    expect(await outcome).toBe("last_admin");
    expect((await stored(a.id)).roles).toEqual(["facility_admin"]);
  });

  it("is the facility admin's, and only for this facility's members", async () => {
    const facility = await makeFacility();
    const other = await makeFacility();
    const admin = await adminOf(facility.id);
    const doctor = await signedInUserAt(facility.id, ["doctor"]);
    const clerk = await memberWith(facility.id, ["records_clerk"]);
    const elsewhere = await memberWith(other.id, ["records_clerk"]);

    expect((await setRoles(facility.id, doctor, clerk.id, { roles: ["cashier"] })).status).toBe(403);
    expect((await setRoles(facility.id, admin, elsewhere.id, { roles: ["cashier"] })).status).toBe(404);
    expect((await stored(elsewhere.id)).roles).toEqual(["records_clerk"]);
  });
});

describe("the database's licence guards", () => {
  beforeEach(async () => {
    await resetDb();
  });

  // Owner connection, so nothing but the CHECKs stands in the way.
  async function insertMembership(roles: string[], profession: string | null, number: string | null, expiresOn: string | null) {
    const facility = await makeFacility();
    const person = await signedInUser();
    return pool.query(
      `INSERT INTO memberships (facility_id, user_id, roles, licence_profession, licence_number, licence_expires_on)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [facility.id, person.id, roles, profession, number, expiresOn],
    );
  }

  const expiresOn = "2030-01-01";

  it.each([
    ["a clinical role without a licence", ["doctor"], null, null, null, "memberships_licence_iff_clinical"],
    ["a licence without a clinical role", ["cashier"], null, "A1", expiresOn, "memberships_licence_iff_clinical"],
    ["a number without its expiry", ["doctor"], "medical_practitioner", "A1", null, "memberships_licence_iff_clinical"],
    ["a number without its profession", ["doctor"], null, "A1", expiresOn, "memberships_licence_iff_clinical"],
    // Unknown, so it fits no role either; Postgres names whichever CHECK it meets first.
    ["a profession it does not know", ["doctor"], "herbalist", "A1", expiresOn, /^memberships_licence_(profession_known|fits_roles)$/],
    ["a licence in a profession no role belongs to", ["doctor"], "nurse", "A1", expiresOn, "memberships_licence_fits_roles"],
    ["a number as typed, not normalised", ["doctor"], "medical_practitioner", "a 1", expiresOn, "memberships_licence_number_shape"],
  ])("refuses %s", async (_, roles, profession, number, expires, constraint) => {
    await expect(insertMembership(roles, profession, number, expires)).rejects.toMatchObject({
      code: "23514",
      constraint: typeof constraint === "string" ? constraint : expect.stringMatching(constraint),
    });
  });

  it("allows an admin who is also a doctor, and roles from two professions under one licence", async () => {
    await expect(insertMembership(["facility_admin", "doctor"], "medical_practitioner", "A1", expiresOn)).resolves.toBeDefined();
    await expect(insertMembership(["nurse", "pharm_tech", "storekeeper"], "nurse", "NCK1", expiresOn)).resolves.toBeDefined();
  });

  it("guards an invitation the same way, since it becomes a membership", async () => {
    const facility = await makeFacility();
    const admin = await signedInUser();

    await expect(pool.query(
      "INSERT INTO invitations (facility_id, email, name, roles, invited_by, expires_at) VALUES ($1, 'x@example.test', 'X Y', ARRAY['nurse'], $2, now())",
      [facility.id, admin.id],
    )).rejects.toMatchObject({ code: "23514", constraint: "invitations_licence_iff_clinical" });
  });
});
