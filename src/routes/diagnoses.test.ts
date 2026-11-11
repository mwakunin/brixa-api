import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { pool } from "@/db";
import { addDays, businessDate } from "@/lib/dates";
import { loadIcd11 } from "@/lib/icd11-load";
import { addMembership, makeOnboardedFacility, resetDb, signedInUser } from "@/test/helpers";
import { call } from "@/test/hospital";

/** P3 slice 3a: diagnoses coded in ICD-11. The codes come from real WHO rows (see lib/icd11.test.ts). */

const SAMPLE = path.resolve(import.meta.dirname, "../test/fixtures/icd11-mms-sample.txt");

type Roles = Parameters<typeof addMembership>[2];

async function clinic() {
  const facility = await makeOnboardedFacility();
  const person = async (roles: Roles, licence?: { number: string; expiresOn: string }) => {
    const user = await signedInUser();
    const membership = await addMembership(user.id, facility.id, roles, licence ? { licence } : {});
    return { ...user, actor: { userId: user.id, membershipId: membership.id } };
  };
  const clerk = await person(["records_clerk"]);
  const doctor = await person(["doctor"]);
  const officer = await person(["clinical_officer"]);
  const cashier = await person(["cashier"]);
  const pharmacist = await person(["pharmacist"]);

  const visit = async () => {
    const patientId = (await (await call("POST", "/patients", facility.id, clerk, {
      givenName: "Wanjiku",
      familyName: "Mwangi",
      sex: "female",
      dateOfBirth: "1992-08-20",
      noPhoneReason: "no_phone",
      noIdReason: "not_carried",
      confirmNotDuplicate: true,
    })).json()).id;
    return (await call("POST", "/encounters", facility.id, clerk, { patientId, kind: "opd", queueAt: null })).json();
  };

  return { facility, person, clerk, doctor, officer, cashier, pharmacist, visit };
}

type Clinic = Awaited<ReturnType<typeof clinic>>;
type Person = Clinic["doctor"];

const at = (c: Clinic, who: Person, method: string, path: string, body?: unknown) => call(method, path, c.facility.id, who, body);
const diagnose = (c: Clinic, who: Person, encounterId: string, body: unknown) => at(c, who, "POST", `/encounters/${encounterId}/diagnoses`, body);
const listOf = async (c: Clinic, encounterId: string) => (await (await at(c, c.doctor, "GET", `/encounters/${encounterId}/diagnoses`)).json()).diagnoses;

beforeEach(async () => {
  await resetDb();
  await loadIcd11(await readFile(SAMPLE, "utf8"));
});

describe("diagnoses", () => {
  it("are found by name, recorded with the code's title and URI, and the first is the principal", async () => {
    const c = await clinic();
    const visit = await c.visit();

    const found = await (await at(c, c.officer, "GET", "/icd-codes?q=falciparum unspec")).json();
    expect(found.codes.map((m: { code: string }) => m.code)).toEqual(["1F40.Z"]);

    const malaria = await diagnose(c, c.officer, visit.id, { code: "1f40.z", certainty: "provisional" });
    expect(malaria.status).toBe(201);
    expect(await malaria.json()).toMatchObject({
      code: "1F40.Z",
      title: "Malaria due to Plasmodium falciparum, unspecified",
      uri: expect.stringContaining("http://id.who.int/icd/release/11/mms/"),
      release: "2026-01",
      certainty: "provisional",
      rank: "principal",
      diagnosedBy: { membershipId: c.officer.actor.membershipId },
    });
    expect(await (await diagnose(c, c.officer, visit.id, { code: "CA40.01", certainty: "confirmed" })).json()).toMatchObject({ rank: "secondary" });
    expect(await (await diagnose(c, c.doctor, visit.id, { code: "1C62.0", certainty: "confirmed", principal: true })).json()).toMatchObject({ rank: "principal" });

    expect((await listOf(c, visit.id)).map((d: { code: string; rank: string }) => [d.code, d.rank])).toEqual([
      ["1C62.0", "principal"],
      ["1F40.Z", "secondary"],
      ["CA40.01", "secondary"],
    ]);
  });

  it("keep what was diagnosed when a later release retitles the code", async () => {
    const c = await clinic();
    const visit = await c.visit();
    await diagnose(c, c.doctor, visit.id, { code: "1F40.0", certainty: "confirmed" });

    const later = (await readFile(SAMPLE, "utf8"))
      .replace("Version:2026 Jan", "Version:2027 Jan")
      .replace("- - - - Plasmodium falciparum malaria with cerebral complications", "- - - - Cerebral falciparum malaria");
    await loadIcd11(later);

    expect((await listOf(c, visit.id))[0]).toMatchObject({ title: "Plasmodium falciparum malaria with cerebral complications", release: "2026-01" });
  });

  it("are confirmed once, also after the visit has closed, and recorded only on an open one", async () => {
    const c = await clinic();
    const visit = await c.visit();
    const malaria = await (await diagnose(c, c.doctor, visit.id, { code: "1F40.Z", certainty: "provisional" })).json();
    expect((await at(c, c.clerk, "POST", `/encounters/${visit.id}/close`)).status).toBe(200);

    const confirmed = await at(c, c.doctor, "POST", `/diagnoses/${malaria.id}/confirm`);
    expect(await confirmed.json()).toMatchObject({ certainty: "confirmed", confirmedAt: expect.any(String) });
    expect((await (await at(c, c.doctor, "POST", `/diagnoses/${malaria.id}/confirm`)).json()).code).toBe("not_provisional");
    expect((await (await diagnose(c, c.doctor, visit.id, { code: "CA40.00", certainty: "confirmed" })).json()).code).toBe("not_open");
  });

  it("are ruled out or marked entered in error once, and an ended one does not change", async () => {
    const c = await clinic();
    const visit = await c.visit();
    const first = await (await diagnose(c, c.doctor, visit.id, { code: "1F40.Z", certainty: "provisional" })).json();
    const second = await (await diagnose(c, c.doctor, visit.id, { code: "CA40.00", certainty: "provisional" })).json();

    const ruledOut = await at(c, c.doctor, "POST", `/diagnoses/${first.id}/end`, { reason: "ruled_out" });
    expect(await ruledOut.json()).toMatchObject({ endReason: "ruled_out", endedAt: expect.any(String) });
    for (const [path, body] of [["end", { reason: "entered_in_error" }], ["confirm", undefined], ["principal", undefined]] as const)
      expect((await (await at(c, c.doctor, "POST", `/diagnoses/${first.id}/${path}`, body)).json()).code).toBe("ended");

    expect(await (await at(c, c.doctor, "POST", `/diagnoses/${second.id}/principal`)).json()).toMatchObject({ rank: "principal" });
    expect((await listOf(c, visit.id)).map((d: { code: string; endReason: string | null }) => [d.code, d.endReason])).toEqual([
      ["CA40.00", null],
      ["1F40.Z", "ruled_out"],
    ]);
  });

  it("refuse a code too broad, unknown or retired, and the same diagnosis twice", async () => {
    const c = await clinic();
    const visit = await c.visit();
    const pathOf = async (res: Response) => (await res.json()).error.issues[0].path;

    expect(await pathOf(await diagnose(c, c.doctor, visit.id, { code: "1F40", certainty: "confirmed" }))).toEqual(["code"]);
    expect(await pathOf(await diagnose(c, c.doctor, visit.id, { code: "1A00", certainty: "confirmed" }))).toEqual(["code"]);
    await diagnose(c, c.doctor, visit.id, { code: "1F40.Z", certainty: "confirmed" });
    expect((await (await diagnose(c, c.officer, visit.id, { code: "1F40.Z", certainty: "provisional" })).json()).code).toBe("already_diagnosed");

    const later = (await readFile(SAMPLE, "utf8")).replace("Version:2026 Jan", "Version:2027 Jan").split("\r\n").filter(l => !l.includes("\tCA40.01\t")).join("\r\n");
    await loadIcd11(later);
    const retired = await diagnose(c, c.doctor, visit.id, { code: "CA40.01", certainty: "confirmed" });
    expect((await retired.json()).error.issues[0].message).toMatch(/current ICD-11 release/);
  });

  it("are made by licensed clinicians and read by clinical staff", async () => {
    const c = await clinic();
    const visit = await c.visit();
    const lapsed = await c.person(["doctor"], { number: "A9", expiresOn: addDays(businessDate(), -1) });
    const body = { code: "1F40.Z", certainty: "confirmed" };

    expect((await diagnose(c, c.clerk, visit.id, body)).status).toBe(403);
    expect((await (await diagnose(c, lapsed, visit.id, body)).json()).code).toBe("licence_expired");
    expect((await at(c, c.cashier, "GET", `/encounters/${visit.id}/diagnoses`)).status).toBe(403);
    expect((await at(c, c.cashier, "GET", "/icd-codes?q=malaria")).status).toBe(403);
    expect((await at(c, c.pharmacist, "GET", `/encounters/${visit.id}/diagnoses`)).status).toBe(200);
  });

  it("keep a visit from being cancelled until they are ended", async () => {
    const c = await clinic();
    const visit = await c.visit();
    const malaria = await (await diagnose(c, c.doctor, visit.id, { code: "1F40.Z", certainty: "provisional" })).json();
    const cancel = () => at(c, c.clerk, "POST", `/encounters/${visit.id}/cancel`, { reason: "Wrong patient" });

    expect((await (await cancel()).json()).code).toBe("has_clinical_records");
    await at(c, c.doctor, "POST", `/diagnoses/${malaria.id}/end`, { reason: "entered_in_error" });
    expect((await cancel()).status).toBe(200);
  });

  it("keep one standing principal when two clinicians each make theirs principal at once", async () => {
    const c = await clinic();
    const visit = await c.visit();

    const results = await Promise.all([
      diagnose(c, c.doctor, visit.id, { code: "1F40.Z", certainty: "confirmed", principal: true }),
      diagnose(c, c.officer, visit.id, { code: "CA40.00", certainty: "confirmed", principal: true }),
    ]);

    expect(results.map(r => r.status)).toEqual([201, 201]);
    expect((await listOf(c, visit.id)).filter((d: { rank: string }) => d.rank === "principal")).toHaveLength(1);
  });

  it("are guarded by the database for every role", async () => {
    const c = await clinic();
    const visit = await c.visit();
    const malaria = await (await diagnose(c, c.doctor, visit.id, { code: "1F40.Z", certainty: "provisional" })).json();
    const state = (q: Promise<unknown>) => q.then(() => "ok", (e: { constraint?: string; code?: string }) => e.constraint ?? e.code);
    const copy = (overrides: string) => pool.query(
      `INSERT INTO diagnoses (facility_id, encounter_id, icd_code, icd_title, icd_uri, icd_release, certainty, rank, diagnosed_at, diagnosed_by${overrides ? ", ended_at, ended_by, end_reason" : ""})
       SELECT facility_id, encounter_id, 'CA40.00', icd_title, icd_uri, icd_release, certainty, rank, diagnosed_at, diagnosed_by${overrides} FROM diagnoses WHERE id = $1`,
      [malaria.id],
    );

    expect(await state(copy(""))).toBe("diagnoses_one_standing_principal");
    expect(await state(copy(", now(), diagnosed_by, 'ruled_out'"))).toBe("23514");
    expect(await state(pool.query("UPDATE diagnoses SET icd_title = 'Something else' WHERE id = $1", [malaria.id]))).toBe("23001");
    // Confirmed without saying when and by whom, it could never be said later.
    expect(await state(pool.query("UPDATE diagnoses SET certainty = 'confirmed' WHERE id = $1", [malaria.id]))).toBe("23514");
    await pool.query("UPDATE diagnoses SET certainty = 'confirmed', confirmed_at = now(), confirmed_by = diagnosed_by WHERE id = $1", [malaria.id]);
    expect(await state(pool.query("UPDATE diagnoses SET certainty = 'provisional', confirmed_at = NULL, confirmed_by = NULL WHERE id = $1", [malaria.id]))).toBe("23001");
    expect(await state(pool.query("DELETE FROM diagnoses WHERE id = $1", [malaria.id]))).toBe("23001");
    expect(await state(pool.query("UPDATE diagnoses SET icd_code = 'ZZZZ' WHERE id = $1", [malaria.id]))).toBe("23001");
  });
});
