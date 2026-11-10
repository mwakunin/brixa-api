import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import db, { pool } from "@/db";
import { auditLog } from "@/db/schema";
import { addDays, businessDate } from "@/lib/dates";
import { addMembership, makeOnboardedFacility, resetDb, signedInUser } from "@/test/helpers";
import { call } from "@/test/hospital";

/** P3 slice 3b: clinical notes, drafted, signed, corrected by addendum. */

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
  const wardNurse = await person(["ward_nurse"]);
  const cashier = await person(["cashier"]);
  const pharmacist = await person(["pharmacist"]);

  const visit = async () => {
    const patientId = (await (await call("POST", "/patients", facility.id, clerk, {
      givenName: "Otieno",
      familyName: "Omondi",
      sex: "male",
      dateOfBirth: "1978-02-02",
      noPhoneReason: "no_phone",
      noIdReason: "not_carried",
      confirmNotDuplicate: true,
    })).json()).id;
    return (await call("POST", "/encounters", facility.id, clerk, { patientId, kind: "opd", queueAt: null })).json();
  };

  return { facility, person, clerk, doctor, officer, wardNurse, cashier, pharmacist, visit };
}

type Clinic = Awaited<ReturnType<typeof clinic>>;
type Person = Clinic["doctor"];

const at = (c: Clinic, who: Person, method: string, path: string, body?: unknown) => call(method, path, c.facility.id, who, body);
const consultation = { kind: "consultation", presentingComplaint: "Fever for 3 days", examination: "Temp 38.6, no neck stiffness" };
async function start(c: Clinic, who: Person, encounterId: string, body: unknown = consultation) {
  return (await at(c, who, "POST", `/encounters/${encounterId}/notes`, body)).json();
}
async function notesAs(c: Clinic, who: Person, encounterId: string) {
  return (await (await at(c, who, "GET", `/encounters/${encounterId}/notes`)).json()).notes;
}

beforeEach(async () => {
  await resetDb();
});

describe("clinical notes", () => {
  it("are drafted, saved, and signed by their author, then frozen", async () => {
    const c = await clinic();
    const visit = await c.visit();

    const draft = await start(c, c.officer, visit.id);
    expect(draft).toMatchObject({ kind: "consultation", status: "draft", presentingComplaint: "Fever for 3 days", history: null, plan: null, signedAt: null, addenda: [] });

    const saved = await at(c, c.officer, "PUT", `/notes/${draft.id}`, { ...consultation, plan: "  Malaria RDT; paracetamol  " });
    expect(await saved.json()).toMatchObject({ status: "draft", plan: "Malaria RDT; paracetamol" });

    const signed = await at(c, c.officer, "POST", `/notes/${draft.id}/sign`);
    expect(await signed.json()).toMatchObject({ status: "signed", signedAt: expect.any(String), writtenBy: { membershipId: c.officer.actor.membershipId } });
    expect((await (await at(c, c.officer, "PUT", `/notes/${draft.id}`, consultation)).json()).code).toBe("not_a_draft");
    expect((await (await at(c, c.officer, "POST", `/notes/${draft.id}/sign`)).json()).code).toBe("not_a_draft");
  });

  it("keep a draft its author's alone: nobody else sees or changes it", async () => {
    const c = await clinic();
    const visit = await c.visit();
    const draft = await start(c, c.officer, visit.id);

    expect(await notesAs(c, c.doctor, visit.id)).toEqual([]);
    expect((await at(c, c.doctor, "PUT", `/notes/${draft.id}`, consultation)).status).toBe(404);
    expect((await at(c, c.doctor, "POST", `/notes/${draft.id}/sign`)).status).toBe(404);
    expect(await notesAs(c, c.officer, visit.id)).toHaveLength(1);

    await at(c, c.officer, "POST", `/notes/${draft.id}/sign`);
    expect(await notesAs(c, c.doctor, visit.id)).toHaveLength(1);
  });

  it("are corrected by addenda, shown under the note", async () => {
    const c = await clinic();
    const visit = await c.visit();
    const note = await start(c, c.officer, visit.id);
    // A draft takes no addendum; to anyone but its author it does not exist at all.
    expect((await (await at(c, c.officer, "POST", `/notes/${note.id}/addenda`, { text: "Too early" })).json()).code).toBe("not_signed");
    expect((await at(c, c.doctor, "POST", `/notes/${note.id}/addenda`, { text: "Too early" })).status).toBe(404);
    await at(c, c.officer, "POST", `/notes/${note.id}/sign`);

    const added = await at(c, c.doctor, "POST", `/notes/${note.id}/addenda`, { text: "Reviewed: RDT positive, start AL" });
    expect(added.status).toBe(201);
    const [shown] = await notesAs(c, c.officer, visit.id);
    expect(shown.addenda).toEqual([expect.objectContaining({ text: "Reviewed: RDT positive, start AL", writtenBy: expect.objectContaining({ membershipId: c.doctor.actor.membershipId }) })]);
    expect(shown.examination).toBe("Temp 38.6, no neck stiffness");
  });

  it("let a draft be discarded, never deleted, and no longer shown", async () => {
    const c = await clinic();
    const visit = await c.visit();
    const draft = await start(c, c.officer, visit.id);

    expect(await (await at(c, c.officer, "POST", `/notes/${draft.id}/discard`)).json()).toEqual({ id: draft.id, status: "discarded" });
    expect(await notesAs(c, c.officer, visit.id)).toEqual([]);
    const { rows } = await pool.query("SELECT status FROM clinical_notes WHERE id = $1", [draft.id]);
    expect(rows).toEqual([{ status: "discarded" }]);
  });

  it("are written by the right roles under a current licence, and read by clinical staff", async () => {
    const c = await clinic();
    const visit = await c.visit();
    const nursing = { kind: "nursing", text: "Patient comfortable, taking fluids" };
    const lapsed = await c.person(["doctor"], { number: "A1", expiresOn: addDays(businessDate(), -1) });

    expect((await at(c, c.wardNurse, "POST", `/encounters/${visit.id}/notes`, consultation)).status).toBe(403);
    expect((await at(c, c.wardNurse, "POST", `/encounters/${visit.id}/notes`, nursing)).status).toBe(201);
    expect((await at(c, c.clerk, "POST", `/encounters/${visit.id}/notes`, consultation)).status).toBe(403);
    expect((await (await at(c, lapsed, "POST", `/encounters/${visit.id}/notes`, consultation)).json()).code).toBe("licence_expired");
    expect((await at(c, c.cashier, "GET", `/encounters/${visit.id}/notes`)).status).toBe(403);
    expect((await at(c, c.pharmacist, "GET", `/encounters/${visit.id}/notes`)).status).toBe(200);

    const viewed = await db.select().from(auditLog).where(and(eq(auditLog.action, "encounter.viewed"), eq(auditLog.actorId, c.pharmacist.id)));
    expect(viewed.map(v => v.summary)).toEqual(["Viewed clinical notes (0)"]);
  });

  it("need content that fits the kind", async () => {
    const c = await clinic();
    const visit = await c.visit();
    const refused = async (who: Person, body: unknown) => (await at(c, who, "POST", `/encounters/${visit.id}/notes`, body)).status;

    expect(await refused(c.officer, { kind: "consultation", presentingComplaint: "   " })).toBe(422);
    expect(await refused(c.officer, { kind: "consultation", text: "Free text instead" })).toBe(422);
    expect(await refused(c.wardNurse, { kind: "nursing", plan: "A plan, no text" })).toBe(422);
  });

  it("are started on an open visit and may be signed after it closes", async () => {
    const c = await clinic();
    const visit = await c.visit();
    const draft = await start(c, c.officer, visit.id);
    await at(c, c.clerk, "POST", `/encounters/${visit.id}/close`);

    expect((await (await at(c, c.officer, "POST", `/encounters/${visit.id}/notes`, consultation)).json()).code).toBe("not_open");
    expect(await (await at(c, c.officer, "POST", `/notes/${draft.id}/sign`)).json()).toMatchObject({ status: "signed" });
  });

  it("keep a visit from being cancelled until drafts are discarded and signed notes marked entered in error", async () => {
    const c = await clinic();
    const visit = await c.visit();
    const signed = await start(c, c.officer, visit.id);
    await at(c, c.officer, "POST", `/notes/${signed.id}/sign`);
    const draft = await start(c, c.doctor, visit.id);
    const cancel = () => at(c, c.clerk, "POST", `/encounters/${visit.id}/cancel`, { reason: "Wrong patient" });

    expect((await (await cancel()).json()).code).toBe("has_clinical_records");
    const marked = await at(c, c.doctor, "POST", `/notes/${signed.id}/entered-in-error`, { reason: "Written on the wrong patient" });
    expect(await marked.json()).toMatchObject({ enteredInError: { reason: "Written on the wrong patient" } });
    expect((await (await at(c, c.doctor, "POST", `/notes/${signed.id}/addenda`, { text: "More" })).json()).code).toBe("entered_in_error");
    expect((await (await cancel()).json()).code).toBe("has_clinical_records");

    await at(c, c.doctor, "POST", `/notes/${draft.id}/discard`);
    expect((await cancel()).status).toBe(200);
  });

  it("are guarded by the database for every role", async () => {
    const c = await clinic();
    const visit = await c.visit();
    const note = await start(c, c.officer, visit.id);
    const draft = await start(c, c.officer, visit.id);
    await at(c, c.officer, "POST", `/notes/${note.id}/sign`);
    const state = (q: Promise<unknown>) => q.then(() => "ok", (e: { constraint?: string; code?: string }) => e.constraint ?? e.code);

    expect(await state(pool.query("UPDATE clinical_notes SET plan = 'Changed later' WHERE id = $1", [note.id]))).toBe("23001");
    expect(await state(pool.query("UPDATE clinical_notes SET written_by = $2 WHERE id = $1", [draft.id, c.doctor.actor.membershipId]))).toBe("23001");
    expect(await state(pool.query("DELETE FROM clinical_notes WHERE id = $1", [draft.id]))).toBe("23001");
    expect(await state(pool.query(
      `INSERT INTO clinical_notes (facility_id, encounter_id, kind, addendum_of, text, status, written_by, created_at, updated_at, signed_at)
       SELECT facility_id, encounter_id, 'addendum', id, 'To a draft', 'signed', written_by, now(), now(), now() FROM clinical_notes WHERE id = $1`,
      [draft.id],
    ))).toBe("23514");
    // Only a signed note is marked entered in error: the trigger, ahead of the CHECK.
    expect(await state(pool.query("UPDATE clinical_notes SET entered_in_error_at = now(), entered_in_error_by = written_by, entered_in_error_reason = 'x' WHERE id = $1", [draft.id]))).toBe("23514");
    await pool.query("UPDATE clinical_notes SET status = 'discarded', discarded_at = now() WHERE id = $1", [draft.id]);
    expect(await state(pool.query("UPDATE clinical_notes SET plan = 'Revived' WHERE id = $1", [draft.id]))).toBe("23001");
  });
});
