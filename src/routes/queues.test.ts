import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import app from "@/app";
import db, { pool } from "@/db";
import { auditLog, encounters, queueEntries } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import { closeStaleVisits } from "@/jobs/visits";
import { addDays, ageInYears, businessDate } from "@/lib/dates";
import { serve } from "@/lib/queues";
import { addMembership, backendPid, makeFacility, makeOnboardedFacility, resetDb, signedInUser, waitForBlockedBackend } from "@/test/helpers";
import { call } from "@/test/hospital";

type Roles = Parameters<typeof addMembership>[2];

/** A facility with an OP register, and the staff an outpatient department needs. */
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

  const point = async (name: string, kind: "triage" | "consultation") =>
    (await (await call("POST", "/service-points", facility.id, admin, { name, kind })).json()).id as string;

  const patient = async (givenName = "Amina") => (await (await call("POST", "/patients", facility.id, clerk, {
    givenName,
    familyName: "Wafula",
    sex: "female",
    dateOfBirth: "1990-05-01",
    noPhoneReason: "no_phone",
    noIdReason: "not_carried",
    confirmNotDuplicate: true,
  })).json()).id as string;

  const visit = async (body: Record<string, unknown> = {}) =>
    (await call("POST", "/encounters", facility.id, clerk, { patientId: await patient(), kind: "opd", ...body })).json();

  const view = async (encounterId: string) =>
    (await call("GET", `/encounters/${encounterId}`, facility.id, clerk)).json();

  const queue = async (servicePointId: string, who = nurse) =>
    (await call("GET", `/service-points/${servicePointId}/queue`, facility.id, who)).json();

  return { facility, person, admin, clerk, nurse, doctor, cashier, point, patient, visit, view, queue };
}

type Clinic = Awaited<ReturnType<typeof clinic>>;

const post = (c: Clinic, path: string, who: Clinic["nurse"], body?: unknown) => call("POST", path, c.facility.id, who, body);

describe("service points", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("are set up by the facility admin and listed for every member, triage first, with who is waiting", async () => {
    const c = await clinic();
    await c.point("MCH", "consultation");
    const gopd = await c.point("General OPD", "consultation");
    const triage = await c.point("Triage", "triage");
    await c.visit({ queueAt: gopd });

    const listed = await (await call("GET", "/service-points", c.facility.id, c.cashier)).json();

    expect(listed.servicePoints).toEqual([
      { id: triage, name: "Triage", kind: "triage", consultationItemId: null, isActive: true, waiting: 0 },
      { id: gopd, name: "General OPD", kind: "consultation", consultationItemId: null, isActive: true, waiting: 1 },
      expect.objectContaining({ name: "MCH", waiting: 0 }),
    ]);
    const again = await post(c, "/service-points", c.admin, { name: "MCH", kind: "consultation" });
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe("name_taken");
    expect((await post(c, "/service-points", c.nurse, { name: "Dental", kind: "consultation" })).status).toBe(403);
  });

  it("can be renamed, and retired only once nobody is waiting there", async () => {
    const c = await clinic();
    const triage = await c.point("Triage", "triage");
    const visit = await c.visit();
    const retire = () => call("PATCH", `/service-points/${triage}`, c.facility.id, c.admin, { isActive: false });

    const refused = await retire();
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("still_waiting");

    await post(c, `/queue-entries/${visit.queue.entryId}/remove`, c.clerk, { outcome: "left" });
    expect((await retire()).status).toBe(200);
    const renamed = await call("PATCH", `/service-points/${triage}`, c.facility.id, c.admin, { name: "Old triage" });
    expect(await renamed.json()).toMatchObject({ name: "Old triage", isActive: false });

    const join = await post(c, `/encounters/${visit.id}/queue`, c.clerk, { servicePointId: triage });
    expect(join.status).toBe(409);
    expect((await join.json()).code).toBe("service_point_retired");
  });
});

describe("a visit's queue", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("starts at the facility's only triage point, unless told otherwise", async () => {
    const c = await clinic();
    const triage = await c.point("Triage", "triage");

    const visit = await c.visit();
    expect(visit.queue).toMatchObject({ servicePointId: triage, servicePointName: "Triage", status: "waiting", servingAt: null });

    const walkIn = await c.visit({ queueAt: null });
    expect(walkIn.queue).toBeNull();
  });

  it("joins no queue by default with two triage points, and the one named", async () => {
    const c = await clinic();
    await c.point("Triage A", "triage");
    const b = await c.point("Triage B", "triage");

    expect((await c.visit()).queue).toBeNull();
    expect((await c.visit({ queueAt: b })).queue).toMatchObject({ servicePointName: "Triage B" });
  });

  it("takes the patient from triage to a clinic, and names the clinician who saw them", async () => {
    const c = await clinic();
    const triage = await c.point("Triage", "triage");
    const gopd = await c.point("General OPD", "consultation");
    const visit = await c.visit();

    const triaged = await post(c, `/queue-entries/${visit.queue.entryId}/serve`, c.nurse);
    expect(await triaged.json()).toMatchObject({ status: "serving", servedBy: c.nurse.actor.membershipId });
    // Seen at triage is not the attending clinician.
    expect((await c.view(visit.id)).attending).toBeNull();

    const sent = await (await post(c, `/queue-entries/${visit.queue.entryId}/finish`, c.nurse, { nextServicePointId: gopd })).json();
    expect(sent.finished).toMatchObject({ status: "done", servicePointId: triage });
    expect(sent.next).toMatchObject({ status: "waiting", servicePointId: gopd });

    const waiting = await c.queue(gopd, c.doctor);
    expect(waiting.entries).toEqual([expect.objectContaining({
      entryId: sent.next.id,
      status: "waiting",
      servedBy: null,
      patient: expect.objectContaining({ name: "Amina Wafula", sex: "female", ageYears: ageInYears("1990-05-01"), opNumber: expect.any(String) }),
    })]);

    await post(c, `/queue-entries/${sent.next.id}/serve`, c.doctor);
    const seen = await c.view(visit.id);
    expect(seen.queue).toMatchObject({ servicePointName: "General OPD", status: "serving" });
    expect(seen.attending).toEqual({ membershipId: c.doctor.actor.membershipId, name: expect.any(String) });

    const done = await (await post(c, `/queue-entries/${sent.next.id}/finish`, c.doctor, {})).json();
    expect(done.next).toBeNull();
    const after = await c.view(visit.id);
    expect(after.queue).toBeNull();
    expect(after.attending?.membershipId).toBe(c.doctor.actor.membershipId);

    const actions = (await db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityType, "queue_entry"))).map(a => a.action).sort();
    expect(actions).toEqual(["queue.finished", "queue.finished", "queue.joined", "queue.joined", "queue.served", "queue.served"]);
  });

  it("keeps a patient in one queue at a time, and in step", async () => {
    const c = await clinic();
    const triage = await c.point("Triage", "triage");
    const gopd = await c.point("General OPD", "consultation");
    const visit = await c.visit();
    const entry = visit.queue.entryId;

    const twice = await post(c, `/encounters/${visit.id}/queue`, c.clerk, { servicePointId: gopd });
    expect((await twice.json()).code).toBe("already_queued");
    expect((await post(c, `/queue-entries/${entry}/finish`, c.nurse, {})).status).toBe(409);

    expect((await post(c, `/queue-entries/${entry}/serve`, c.nurse)).status).toBe(200);
    const again = await post(c, `/queue-entries/${entry}/serve`, c.doctor);
    expect((await again.json()).code).toBe("not_waiting");
    expect((await c.queue(triage)).entries.map((e: { status: string }) => e.status)).toEqual(["serving"]);
  });

  it("lets only a licensed clinician call a patient in", async () => {
    const c = await clinic();
    await c.point("Triage", "triage");
    const visit = await c.visit();
    const lapsed = await c.person(["nurse"], { number: "NCK9", expiresOn: addDays(businessDate(), -1) });

    expect((await post(c, `/queue-entries/${visit.queue.entryId}/serve`, c.clerk)).status).toBe(403);
    const refused = await post(c, `/queue-entries/${visit.queue.entryId}/serve`, lapsed);
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("licence_expired");
  });

  it("takes out a patient who left or was sent in error, never one being seen", async () => {
    const c = await clinic();
    const triage = await c.point("Triage", "triage");
    const visit = await c.visit();

    const left = await post(c, `/queue-entries/${visit.queue.entryId}/remove`, c.clerk, { outcome: "left" });
    expect(await left.json()).toMatchObject({ status: "left", endedAt: expect.any(String) });

    const back = await (await post(c, `/encounters/${visit.id}/queue`, c.clerk, { servicePointId: triage })).json();
    await post(c, `/queue-entries/${back.id}/serve`, c.nurse);
    const refused = await post(c, `/queue-entries/${back.id}/remove`, c.clerk, { outcome: "cancelled" });
    expect((await refused.json()).code).toBe("not_waiting");
  });

  it("will not close a visit while its patient is queued, and cancels the queue with a visit opened in error", async () => {
    const c = await clinic();
    await c.point("Triage", "triage");
    const visit = await c.visit();

    const closing = await post(c, `/encounters/${visit.id}/close`, c.clerk);
    expect(closing.status).toBe(409);
    expect((await closing.json()).code).toBe("still_queued");

    expect((await post(c, `/encounters/${visit.id}/cancel`, c.clerk, { reason: "Wrong patient" })).status).toBe(200);
    const [entry] = await db.select().from(queueEntries).where(eq(queueEntries.id, visit.queue.entryId));
    expect(entry).toMatchObject({ status: "cancelled", endedBy: c.clerk.actor.membershipId });
  });

  it("will not cancel a visit while its patient is being seen", async () => {
    const c = await clinic();
    await c.point("Triage", "triage");
    const visit = await c.visit();
    await post(c, `/queue-entries/${visit.queue.entryId}/serve`, c.nurse);

    const refused = await post(c, `/encounters/${visit.id}/cancel`, c.clerk, { reason: "Wrong patient" });
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("being_seen");

    await post(c, `/queue-entries/${visit.queue.entryId}/finish`, c.nurse, {});
    expect((await post(c, `/encounters/${visit.id}/cancel`, c.clerk, { reason: "Wrong patient" })).status).toBe(200);
  });

  it("is for queue staff, audited, and this facility's alone", async () => {
    const c = await clinic();
    const triage = await c.point("Triage", "triage");
    const other = await makeFacility();
    await c.visit();

    expect((await call("GET", `/service-points/${triage}/queue`, c.facility.id, c.cashier)).status).toBe(403);
    expect((await c.queue(triage)).entries).toHaveLength(1);
    const [viewed] = await db.select().from(auditLog).where(and(eq(auditLog.action, "queue.viewed"), eq(auditLog.entityId, triage)));
    expect(viewed.actorId).toBe(c.nurse.id);

    const elsewhere = await signedInUser();
    await addMembership(elsewhere.id, other.id, ["nurse"]);
    expect((await call("GET", `/service-points/${triage}/queue`, other.id, elsewhere)).status).toBe(404);
  });

  it("calls a patient in once when two clinicians try at the same moment", async () => {
    const c = await clinic();
    await c.point("Triage", "triage");
    const visit = await c.visit();
    const entry = visit.queue.entryId as string;

    let release!: () => void;
    let ready!: () => void;
    const mayCommit = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let holderPid = 0;
    const first = runAsFacility(c.facility.id, async (tx) => {
      try {
        await serve(tx, c.facility.id, entry, c.nurse.actor);
        holderPid = await backendPid(tx);
      }
      finally {
        ready();
      }
      await mayCommit;
    });
    await started;

    const second = runAsFacility(c.facility.id, tx => serve(tx, c.facility.id, entry, c.doctor.actor));
    const outcome = second.then(() => "served", (err: { code?: string }) => err.code);
    expect(await waitForBlockedBackend(holderPid)).toBe(true);
    release();
    await first;

    expect(await outcome).toBe("not_waiting");
    const [row] = await db.select().from(queueEntries).where(eq(queueEntries.id, entry));
    expect(row.servedBy).toBe(c.nurse.actor.membershipId);
  });
});

describe("the nightly close of outpatient visits", () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function startedYesterday(encounterId: string) {
    await pool.query("UPDATE encounters SET started_at = started_at - interval '1 day' WHERE id = $1", [encounterId]);
  }

  it("closes yesterday's open visits, marking who still waited as having left", async () => {
    const c = await clinic();
    await c.point("Triage", "triage");
    const waited = await c.visit();
    const beingSeen = await c.visit();
    await post(c, `/queue-entries/${beingSeen.queue.entryId}/serve`, c.nurse);
    const today = await c.visit();
    const emergency = (await (await call("POST", "/encounters", c.facility.id, c.clerk, { patientId: await c.patient("Baraka"), kind: "emergency" })).json());
    for (const v of [waited, beingSeen, emergency])
      await startedYesterday(v.id);

    expect(await closeStaleVisits()).toMatchObject({ closed: 2, failed: 0 });

    const status = async (id: string) => (await db.select().from(encounters).where(eq(encounters.id, id)))[0];
    expect(await status(waited.id)).toMatchObject({ status: "closed", closedBy: null });
    expect(await status(beingSeen.id)).toMatchObject({ status: "closed", closedBy: null });
    expect((await status(today.id)).status).toBe("open");
    expect((await status(emergency.id)).status).toBe("open");

    const entry = async (id: string) => (await db.select().from(queueEntries).where(eq(queueEntries.id, id)))[0];
    expect(await entry(waited.queue.entryId)).toMatchObject({ status: "left", endedBy: null });
    expect(await entry(beingSeen.queue.entryId)).toMatchObject({ status: "done", endedBy: null });

    const closedBy = await db.select({ actorId: auditLog.actorId }).from(auditLog).where(and(eq(auditLog.action, "encounter.closed"), eq(auditLog.entityId, waited.id)));
    expect(closedBy).toEqual([{ actorId: null }]);
    expect(await closeStaleVisits()).toMatchObject({ closed: 0 });
  });

  it("closes each visit on its own, so one that fails leaves the rest closed and is named", async () => {
    const c = await clinic();
    const broken = await c.visit({ queueAt: null });
    const fine = await c.visit({ queueAt: null });
    for (const v of [broken, fine])
      await pool.query("UPDATE encounters SET started_at = started_at - interval '1 day' WHERE id = $1", [v.id]);
    // A visit the database refuses to close, as a stand-in for any failure.
    await pool.query(`CREATE FUNCTION test_refuse_close() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id = '${broken.id}' AND NEW.status = 'closed' THEN RAISE EXCEPTION 'refused for the test'; END IF; RETURN NEW; END $$`);
    await pool.query("CREATE TRIGGER test_refuse_close BEFORE UPDATE ON encounters FOR EACH ROW EXECUTE FUNCTION test_refuse_close()");
    try {
      expect(await closeStaleVisits()).toMatchObject({ closed: 1, failed: 1 });
    }
    finally {
      await pool.query("DROP TRIGGER test_refuse_close ON encounters");
      await pool.query("DROP FUNCTION test_refuse_close()");
    }

    const { rows: statuses } = await pool.query("SELECT id, status FROM encounters WHERE id = ANY($1)", [[broken.id, fine.id]]);
    expect(Object.fromEntries(statuses.map(r => [r.id, r.status]))).toEqual({ [broken.id]: "open", [fine.id]: "closed" });
    const { rows: failures } = await pool.query("SELECT subject_id, resolved_at FROM job_failures WHERE job = 'visit_close'");
    expect(failures).toEqual([{ subject_id: broken.id, resolved_at: null }]);

    // The next clean run closes it and resolves the failure.
    expect(await closeStaleVisits()).toMatchObject({ closed: 1, failed: 0 });
    const { rows: [resolved] } = await pool.query("SELECT resolved_at IS NOT NULL AS resolved FROM job_failures WHERE job = 'visit_close'");
    expect(resolved.resolved).toBe(true);
  });

  it("resolves a facility's earlier failure once a later run succeeds, not one recorded since", async () => {
    const c = await clinic();
    await pool.query(
      `INSERT INTO job_failures (facility_id, job, error, failed_at) VALUES
         ($1, 'visit_close', 'earlier', now() - interval '1 day'),
         ($1, 'visit_close', 'overlapping', now() + interval '1 hour')`,
      [c.facility.id],
    );

    await closeStaleVisits();

    const { rows } = await pool.query("SELECT error, resolved_at IS NOT NULL AS resolved FROM job_failures WHERE job = 'visit_close' ORDER BY error");
    expect(rows).toEqual([{ error: "earlier", resolved: true }, { error: "overlapping", resolved: false }]);
  });

  it("is an internal job, called by Cloud Scheduler alone", async () => {
    expect((await app.request("/internal/jobs/close-visits", { method: "POST" })).status).toBe(401);
  });
});

describe("the database's queue guards", () => {
  beforeEach(async () => {
    await resetDb();
  });

  /** A visit waiting at triage, and the rows a guard test needs to name. */
  async function waiting() {
    const c = await clinic();
    const triage = await c.point("Triage", "triage");
    const gopd = await c.point("General OPD", "consultation");
    const visit = await c.visit();
    return { c, triage, gopd, visit, entryId: visit.queue.entryId as string };
  }

  async function sqlState(query: Promise<unknown>) {
    return query.then(() => "ok", (err: { code?: string }) => err.code);
  }

  /** Owner connection: nothing but the database stands in the way. */
  function insertEntry(facilityId: string, encounterId: string, servicePointId: string, joinedBy: string, status = "waiting") {
    return pool.query(
      `INSERT INTO queue_entries (facility_id, encounter_id, service_point_id, joined_at, joined_by, status, serving_at, served_by)
       VALUES ($1, $2, $3, now(), $4, $5, CASE WHEN $5 = 'serving' THEN now() END, CASE WHEN $5 = 'serving' THEN $4::uuid END)`,
      [facilityId, encounterId, servicePointId, joinedBy, status],
    );
  }

  it("refuses an entry that does not start waiting, or a second live one", async () => {
    const { c, gopd, visit } = await waiting();
    const by = c.clerk.actor.membershipId;
    const other = (await c.visit({ queueAt: null })).id;

    expect(await sqlState(insertEntry(c.facility.id, other, gopd, by, "serving"))).toBe("23514");
    expect(await sqlState(insertEntry(c.facility.id, visit.id, gopd, by))).toBe("23505");
  });

  it("refuses an entry for a closed visit, an admission, or a retired point", async () => {
    const { c, gopd } = await waiting();
    const by = c.clerk.actor.membershipId;
    const closed = (await c.visit({ queueAt: null })).id;
    await post(c, `/encounters/${closed}/close`, c.clerk);
    const { rows: [admission] } = await pool.query(
      `INSERT INTO encounters (facility_id, patient_id, kind, opened_by) VALUES ($1, $2, 'ipd', $3) RETURNING id`,
      [c.facility.id, await c.patient("Imani"), by],
    );
    const open = (await c.visit({ queueAt: null })).id;
    await pool.query("UPDATE service_points SET is_active = false WHERE id = $1", [gopd]);

    expect(await sqlState(insertEntry(c.facility.id, closed, gopd, by))).toBe("23514");
    expect(await sqlState(insertEntry(c.facility.id, admission.id, gopd, by))).toBe("23514");
    expect(await sqlState(insertEntry(c.facility.id, open, gopd, by))).toBe("23514");
  });

  it("holds the lifecycle: in step, what it was never changes, and never deleted", async () => {
    const { c, gopd, entryId } = await waiting();
    const by = c.nurse.actor.membershipId;

    expect(await sqlState(pool.query("UPDATE queue_entries SET status = 'done', serving_at = now(), served_by = $2, ended_at = now() WHERE id = $1", [entryId, by]))).toBe("23001");
    expect(await sqlState(pool.query("UPDATE queue_entries SET service_point_id = $2 WHERE id = $1", [entryId, gopd]))).toBe("23001");
    expect(await sqlState(pool.query("DELETE FROM queue_entries WHERE id = $1", [entryId]))).toBe("23001");

    await pool.query("UPDATE queue_entries SET status = 'left', ended_at = now() WHERE id = $1", [entryId]);
    expect(await sqlState(pool.query("UPDATE queue_entries SET status = 'cancelled', ended_by = $2 WHERE id = $1", [entryId, by]))).toBe("23001");
  });
});
