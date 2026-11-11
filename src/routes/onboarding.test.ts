import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { MembershipRole } from "@/lib/types";

import app from "@/app";
import db, { pool } from "@/db";
import { auditLog, invitations, memberships, numberSeries, outbox, user } from "@/db/schema";
import { drainOutbox } from "@/jobs/outbox-worker";
import { addDays, businessDate } from "@/lib/dates";
import { sentEmails } from "@/lib/email";
import { hashToken, invitationToken } from "@/lib/invitations";
import { isClinicalRole } from "@/lib/practitioners";
import {
  addMembership,
  facilityHeaders,
  makeFacility,
  nextEmail,
  nextIp,
  postJson,
  resetDb,
  signedInUser,
  signedInUserAt,
  signIn,
  waitForBlockedBackend,
} from "@/test/helpers";

const NEW_PASSWORD = "a-brand-new-password";

function onboardingBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "Amani Hospital",
    kmhfrCode: "12345",
    kephLevel: 4,
    county: "Nakuru",
    numbering: { outpatientPrefix: "OPD", nextOutpatientNumber: 1201 },
    admin: { name: "Wanjiru Kamau", email: nextEmail() },
    ...overrides,
  };
}

/** The token from the most recent invitation email to `to`. */
function tokenFor(to: string) {
  const mail = [...sentEmails].reverse().find(m => m.to === to);
  const token = mail?.body.match(/token=([\w-]+)/)?.[1];
  if (!token)
    throw new Error(`No invitation email with a token for ${to}`);
  return token;
}

function accept(body: { token: string; password?: string }, ip = nextIp()) {
  return postJson("/invitations/accept", body, { "x-forwarded-for": ip });
}

async function onboard(superadmin: { headers: { cookie: string } }, overrides: Record<string, unknown> = {}) {
  const body = onboardingBody(overrides);
  const res = await postJson("/superadmin/facilities", body, superadmin.headers);
  return { res, body };
}

describe("onboarding a facility", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("creates the facility, its number series and its first admin's invitation together", async () => {
    const superadmin = await signedInUser({ role: "superadmin" });

    const { res, body } = await onboard(superadmin);

    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created).toMatchObject({ name: "Amani Hospital", kmhfrCode: "12345", status: "active" });

    const series = await db.select().from(numberSeries).where(eq(numberSeries.facilityId, created.id));
    expect(series.map(s => [s.kind, s.prefix, s.resetPeriod, s.padding]).sort()).toEqual([
      ["admission", "ADM-", "yearly", 4],
      ["credit_note", "CN-", "yearly", 6],
      ["inpatient", "IP", "never", 4],
      ["invoice", "INV-", "yearly", 6],
      ["outpatient", "OPD", "never", 4],
      ["prescription", "RX-", "yearly", 6],
      ["receipt", "RCT-", "yearly", 6],
      ["refund", "RFD-", "yearly", 6],
    ]);
    const { rows: counters } = await pool.query<{ kind: string; next_value: number }>(`
      SELECT s.kind, c.next_value FROM number_series_counters c
      JOIN number_series s ON s.id = c.series_id WHERE c.facility_id = $1 ORDER BY s.kind
    `, [created.id]);
    // Continues from the paper register for OP; everything else starts at 1.
    expect(counters).toEqual([
      { kind: "admission", next_value: 1 },
      { kind: "credit_note", next_value: 1 },
      { kind: "inpatient", next_value: 1 },
      { kind: "invoice", next_value: 1 },
      { kind: "outpatient", next_value: 1201 },
      { kind: "prescription", next_value: 1 },
      { kind: "receipt", next_value: 1 },
      { kind: "refund", next_value: 1 },
    ]);

    const [invitation] = await db.select().from(invitations).where(eq(invitations.facilityId, created.id));
    expect(invitation).toMatchObject({
      id: created.adminInvitationId,
      email: body.admin.email,
      roles: ["facility_admin"],
      status: "pending",
      // Set at creation from the derived token, so every send links the same.
      tokenHash: hashToken(invitationToken(created.adminInvitationId)),
    });

    const jobs = await db.select().from(outbox).where(eq(outbox.facilityId, created.id));
    expect(jobs).toMatchObject([{ operation: "invitation.send", subjectId: invitation.id, status: "pending" }]);

    const actions = (await db.select().from(auditLog).where(eq(auditLog.facilityId, created.id)))
      .map(a => a.action)
      .sort();
    expect(actions).toEqual(["facility.created", "invitation.created"]);

    // Nothing is emailed until the outbox runs, after the commit.
    expect(sentEmails).toEqual([]);
  });

  it("is for platform staff only", async () => {
    const member = await signedInUser();

    expect((await onboard(member)).res.status).toBe(403);
    expect((await postJson("/superadmin/facilities", onboardingBody())).status).toBe(401);
  });

  it("refuses a second facility with the same KMHFR code", async () => {
    const superadmin = await signedInUser({ role: "superadmin" });
    await onboard(superadmin);

    const { res } = await onboard(superadmin);

    expect(res.status).toBe(409);
  });

  it("refuses a prefix the number series would not accept", async () => {
    const superadmin = await signedInUser({ role: "superadmin" });

    const { res } = await onboard(superadmin, { numbering: { outpatientPrefix: "OP 1" } });

    expect(res.status).toBe(422);
  });
});

describe("the invitation, from email to first sign-in", () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function onboarded() {
    const superadmin = await signedInUser({ role: "superadmin" });
    const { res, body } = await onboard(superadmin);
    const facility = await res.json();
    await drainOutbox();
    return { facility, adminEmail: body.admin.email as string };
  }

  it("emails a link whose token only the recipient holds", async () => {
    const { facility, adminEmail } = await onboarded();

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]).toMatchObject({ to: adminEmail, subject: "You're invited to Amani Hospital" });
    expect(sentEmails[0].body).toContain("http://localhost:3000/accept-invitation?token=");

    // The database holds the hash, never the token.
    const token = tokenFor(adminEmail);
    const [stored] = await db.select().from(invitations).where(eq(invitations.facilityId, facility.id));
    expect(stored.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it("creates the account and the membership, and the admin can sign in and work", async () => {
    const { facility, adminEmail } = await onboarded();

    const res = await accept({ token: tokenFor(adminEmail), password: NEW_PASSWORD });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ facilityId: facility.id, facilityName: "Amani Hospital", accountCreated: true });

    const session = await signIn(adminEmail, NEW_PASSWORD);
    const here = await app.request("/facility", { headers: facilityHeaders(facility.id, { id: "", email: adminEmail, headers: session }) });
    expect(here.status).toBe(200);
    expect((await here.json()).roles).toEqual(["facility_admin"]);

    const [granted] = await db.select().from(auditLog).where(eq(auditLog.action, "membership.granted"));
    expect(granted).toMatchObject({ facilityId: facility.id, entityType: "membership" });
  });

  it("works once", async () => {
    const { adminEmail } = await onboarded();
    const token = tokenFor(adminEmail);
    await accept({ token, password: NEW_PASSWORD });

    const again = await accept({ token, password: "another-password-x" });

    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe("already_accepted");
    // The first password still stands.
    await expect(signIn(adminEmail, NEW_PASSWORD)).resolves.toBeDefined();
  });

  // A double click: two requests both read the invitation as pending before
  // either commits. Only the row lock stands between them and two accepts.
  it("lets exactly one of two concurrent acceptances through", async () => {
    const { adminEmail } = await onboarded();
    const token = tokenFor(adminEmail);
    const [invitation] = await db.select({ id: invitations.id }).from(invitations);

    // Hold the invitation's row lock so both requests must queue behind it.
    const holder = await pool.connect();
    let both: Promise<Response[]> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM invitations WHERE id = $1 FOR UPDATE", [invitation.id]);
      const holderPid = Number((await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);

      both = Promise.all([
        accept({ token, password: NEW_PASSWORD }),
        accept({ token, password: "another-password-x" }),
      ]);
      expect(await waitForBlockedBackend(holderPid, 5000, 2)).toBe(true);
      await holder.query("COMMIT");

      const results = await both;
      expect(results.map(r => r.status).sort()).toEqual([200, 409]);
      const refused = results.find(r => r.status === 409)!;
      expect((await refused.json()).code).toBe("already_accepted");
    }
    finally {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
      // On a failure above, let the requests finish before the next test resets the database.
      await both?.catch(() => {});
    }

    expect(await db.select().from(memberships)).toHaveLength(1);
  });

  it("needs a password to create a new account", async () => {
    const { adminEmail } = await onboarded();

    const res = await accept({ token: tokenFor(adminEmail) });

    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("password_required");
  });

  it("refuses an unknown token, an expired invitation and a revoked one", async () => {
    const { facility, adminEmail } = await onboarded();
    const token = tokenFor(adminEmail);

    expect((await accept({ token: "x".repeat(43), password: NEW_PASSWORD })).status).toBe(404);

    await db.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.facilityId, facility.id));
    expect((await accept({ token, password: NEW_PASSWORD })).status).toBe(410);

    await db.update(invitations).set({ status: "revoked", expiresAt: new Date(Date.now() + 86_400_000) }).where(eq(invitations.facilityId, facility.id));
    expect((await accept({ token, password: NEW_PASSWORD })).status).toBe(404);
  });

  it("survives redelivery: a second send carries the same link, which still works", async () => {
    const { adminEmail } = await onboarded();
    const firstToken = tokenFor(adminEmail);

    // The worker died after emailing and before recording it: the job comes back.
    await pool.query("UPDATE outbox SET status = 'pending', available_at = now()");
    await drainOutbox();

    expect(sentEmails).toHaveLength(2);
    expect(tokenFor(adminEmail)).toBe(firstToken);
    expect((await accept({ token: firstToken, password: NEW_PASSWORD })).status).toBe(200);
    expect(await db.select().from(memberships)).toHaveLength(1);
  });

  it("removes the account a failed acceptance created, so a retry starts clean", async () => {
    const { adminEmail } = await onboarded();
    const token = tokenFor(adminEmail);

    // Make the tenant half fail after the account has been written.
    await pool.query(`
      CREATE FUNCTION fail_membership() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated failure'; END; $$;
      CREATE TRIGGER fail_membership BEFORE INSERT ON memberships
        FOR EACH ROW EXECUTE FUNCTION fail_membership();
    `);
    try {
      expect((await accept({ token, password: "the-first-password" })).status).toBe(500);
    }
    finally {
      await pool.query("DROP TRIGGER fail_membership ON memberships; DROP FUNCTION fail_membership();");
    }

    const { rows } = await pool.query("SELECT id FROM \"user\" WHERE email = $1", [adminEmail]);
    expect(rows).toEqual([]);

    // The retry's password is the one that counts.
    const retry = await accept({ token, password: NEW_PASSWORD });
    expect(retry.status).toBe(200);
    expect((await retry.json()).accountCreated).toBe(true);
    await expect(signIn(adminEmail, NEW_PASSWORD)).resolves.toBeDefined();
  });

  it("sends nothing for an invitation revoked before the outbox ran", async () => {
    const superadmin = await signedInUser({ role: "superadmin" });
    const { res } = await onboard(superadmin);
    const facility = await res.json();
    await db.update(invitations).set({ status: "revoked" }).where(eq(invitations.facilityId, facility.id));

    const tally = await drainOutbox();

    expect(tally).toMatchObject({ done: 0, skipped: 1 });
    expect(sentEmails).toEqual([]);
  });

  it("lets nobody join, and sends nothing for, a suspended facility", async () => {
    const { facility, adminEmail } = await onboarded();
    const token = tokenFor(adminEmail);
    await pool.query("UPDATE facilities SET status = 'suspended' WHERE id = $1", [facility.id]);

    const res = await accept({ token, password: NEW_PASSWORD });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("facility_suspended");
    expect(await db.select().from(memberships)).toEqual([]);

    // A resend while suspended issues no new link and sends nothing.
    await pool.query("UPDATE outbox SET status = 'pending', available_at = now()");
    await drainOutbox();
    expect(sentEmails).toHaveLength(1);
  });

  it("limits attempts per address", async () => {
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1)
      statuses.push((await accept({ token: `guess-${i}`.padEnd(30, "x") }, ip)).status);

    expect(statuses.slice(0, 10).every(s => s === 404)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe("a facility admin inviting staff", () => {
  beforeEach(async () => {
    await resetDb();
  });

  /** A clinical role gets a valid licence unless the test names one (or `undefined`). */
  function invite(facilityId: string, admin: { headers: { cookie: string } }, body: Record<string, unknown>) {
    const clinical = (body.roles as MembershipRole[]).some(isClinicalRole);
    const withLicence = "licence" in body || !clinical
      ? body
      : { ...body, licence: { number: "NCK-1001", expiresOn: addDays(businessDate(), 365) } };
    return postJson("/staff/invitations", withLicence, facilityHeaders(facilityId, admin as never));
  }

  async function membershipOf(facilityId: string, userEmail: string) {
    const rows = await db.select({ membership: memberships, email: user.email })
      .from(memberships)
      .innerJoin(user, eq(user.id, memberships.userId))
      .where(eq(memberships.facilityId, facilityId));
    return rows.find(r => r.email === userEmail)?.membership;
  }

  it("invites, and the new member accepts and holds exactly those roles", async () => {
    const facility = await makeFacility();
    const admin = await signedInUserAt(facility.id, ["facility_admin"]);
    const email = nextEmail();

    const res = await invite(facility.id, admin, { email, name: "Otieno Ouma", roles: ["cashier", "records_clerk"] });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ email, state: "pending", roles: ["cashier", "records_clerk"] });

    await drainOutbox();
    expect((await accept({ token: tokenFor(email), password: NEW_PASSWORD })).status).toBe(200);

    const here = await app.request("/facility", {
      headers: facilityHeaders(facility.id, { id: "", email, headers: await signIn(email, NEW_PASSWORD) }),
    });
    expect((await here.json()).roles).toEqual(["cashier", "records_clerk"]);
  });

  it("keeps a name to one plain line, since it goes into an email from our domain", async () => {
    const facility = await makeFacility();
    const admin = await signedInUserAt(facility.id, ["facility_admin"]);

    for (const name of ["Otieno\n\nYour account is locked, call 0700 000 000", "A‮reversed", "x".repeat(101)]) {
      const res = await invite(facility.id, admin, { email: nextEmail(), name, roles: ["nurse"] });
      expect(res.status, JSON.stringify(name)).toBe(422);
    }
  });

  it("shows whether each invitation's email went out", async () => {
    const facility = await makeFacility();
    const admin = await signedInUserAt(facility.id, ["facility_admin"]);
    const sent = nextEmail();
    const bounced = nextEmail();
    await invite(facility.id, admin, { email: sent, name: "Sent Person", roles: ["nurse"] });
    await drainOutbox();
    await invite(facility.id, admin, { email: bounced, name: "Bounced Person", roles: ["nurse"] });
    await pool.query("UPDATE outbox SET status = 'failed' WHERE status = 'pending'");
    const queued = nextEmail();
    await invite(facility.id, admin, { email: queued, name: "Queued Person", roles: ["nurse"] });

    const listed = await (await app.request("/staff/invitations", { headers: facilityHeaders(facility.id, admin) })).json();
    const delivery = Object.fromEntries(listed.invitations.map((i: { email: string; delivery: string }) => [i.email, i.delivery]));

    expect(delivery).toEqual({ [sent]: "sent", [bounced]: "failed", [queued]: "queued" });
  });

  it("always lists every pending invitation, however much history there is", async () => {
    const facility = await makeFacility();
    const admin = await signedInUserAt(facility.id, ["facility_admin"]);
    const open = await (await invite(facility.id, admin, { email: nextEmail(), name: "Still Waiting", roles: ["nurse"] })).json();
    await pool.query("UPDATE invitations SET created_at = now() - interval '1 day'");
    // Over two hundred newer, closed invitations.
    await pool.query(`
      INSERT INTO invitations (facility_id, email, name, roles, invited_by, status, expires_at)
      SELECT $1, 'old' || n || '@example.test', 'Old Invitee', ARRAY['records_clerk'], $2, 'revoked', now()
      FROM generate_series(1, 205) AS n
    `, [facility.id, admin.id]);

    const listed = await (await app.request("/staff/invitations", { headers: facilityHeaders(facility.id, admin) })).json();

    expect(listed.invitations.map((i: { id: string }) => i.id)).toContain(open.id);
    expect(listed.invitations).toHaveLength(201);
  });

  it("is for the facility admin only", async () => {
    const facility = await makeFacility();
    const doctor = await signedInUserAt(facility.id, ["doctor"]);

    const res = await invite(facility.id, doctor, { email: nextEmail(), name: "Someone", roles: ["nurse"] });

    expect(res.status).toBe(403);
  });

  it("refuses to invite an existing member, or an address already invited", async () => {
    const facility = await makeFacility();
    const admin = await signedInUserAt(facility.id, ["facility_admin"]);
    const nurse = await signedInUserAt(facility.id, ["nurse"]);
    const email = nextEmail();

    const member = await invite(facility.id, admin, { email: nurse.email, name: "Nurse", roles: ["nurse"] });
    expect(member.status).toBe(409);
    expect((await member.json()).code).toBe("already_member");

    await invite(facility.id, admin, { email, name: "New", roles: ["nurse"] });
    const twice = await invite(facility.id, admin, { email: email.toUpperCase(), name: "New", roles: ["nurse"] });
    expect(twice.status).toBe(409);
    expect((await twice.json()).code).toBe("already_invited");
  });

  it("replaces an expired invitation instead of refusing it", async () => {
    const facility = await makeFacility();
    const admin = await signedInUserAt(facility.id, ["facility_admin"]);
    const email = nextEmail();
    await invite(facility.id, admin, { email, name: "New", roles: ["nurse"] });
    await db.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) });

    const listed = await app.request("/staff/invitations", { headers: facilityHeaders(facility.id, admin) });
    expect((await listed.json()).invitations[0].state).toBe("expired");

    const again = await invite(facility.id, admin, { email, name: "New", roles: ["nurse"] });
    expect(again.status).toBe(201);
    const states = (await db.select().from(invitations)).map(i => i.status).sort();
    expect(states).toEqual(["pending", "revoked"]);
  });

  it("revokes a pending invitation once, and only its own facility's", async () => {
    const facility = await makeFacility();
    const other = await makeFacility();
    const admin = await signedInUserAt(facility.id, ["facility_admin"]);
    const otherAdmin = await signedInUserAt(other.id, ["facility_admin"]);
    const created = await (await invite(facility.id, admin, { email: nextEmail(), name: "New", roles: ["nurse"] })).json();

    const revoke = (headers: Record<string, string>) =>
      app.request(`/staff/invitations/${created.id}/revoke`, { method: "POST", headers });

    expect((await revoke(facilityHeaders(other.id, otherAdmin))).status).toBe(404);
    expect((await revoke(facilityHeaders(facility.id, admin))).status).toBe(200);
    expect((await revoke(facilityHeaders(facility.id, admin))).status).toBe(409);
  });

  it("adds a membership for someone who already has an account, who keeps their password", async () => {
    const first = await makeFacility();
    const second = await makeFacility({ name: "Second Hospital" });
    const locum = await signedInUserAt(first.id, ["doctor"]);
    const admin = await signedInUserAt(second.id, ["facility_admin"]);

    await invite(second.id, admin, { email: locum.email, name: "Locum", roles: ["clinical_officer"] });
    await drainOutbox();

    const res = await accept({ token: tokenFor(locum.email) });
    expect(res.status).toBe(200);
    expect((await res.json()).accountCreated).toBe(false);

    const facilities = await app.request("/me/facilities", { headers: await signIn(locum.email) });
    expect((await facilities.json()).facilities.map((f: { roles: string[] }) => f.roles)).toEqual([
      ["clinical_officer"],
      ["doctor"],
    ]);
  });

  it("brings a former member back with only the roles now offered", async () => {
    const facility = await makeFacility();
    const admin = await signedInUserAt(facility.id, ["facility_admin"]);
    const former = await signedInUser();
    await addMembership(former.id, facility.id, ["pharmacist", "storekeeper"], { isActive: false });

    await invite(facility.id, admin, { email: former.email, name: "Former", roles: ["pharm_tech"] });
    await drainOutbox();
    expect((await accept({ token: tokenFor(former.email) })).status).toBe(200);

    const [membership] = await db.select().from(memberships).where(eq(memberships.userId, former.id));
    expect(membership).toMatchObject({ isActive: true, roles: ["pharm_tech"], licenceNumber: "NCK-1001" });
  });

  it("needs the practising licence of anyone invited to a clinical role, and gives it to their membership", async () => {
    const facility = await makeFacility();
    const admin = await signedInUserAt(facility.id, ["facility_admin"]);
    const email = nextEmail();
    const expiresOn = addDays(businessDate(), 200);

    const without = await invite(facility.id, admin, { email, name: "Achieng Otieno", roles: ["nurse"], licence: undefined });
    expect(without.status).toBe(422);
    expect((await without.json()).error.issues[0].path).toEqual(["licence"]);

    const res = await invite(facility.id, admin, { email, name: "Achieng Otieno", roles: ["nurse"], licence: { number: " nck 12.345 ", expiresOn } });
    expect(res.status).toBe(201);
    expect((await res.json()).licence).toEqual({ profession: "nurse", number: "NCK12345", expiresOn });

    await drainOutbox();
    expect((await accept({ token: tokenFor(email), password: NEW_PASSWORD })).status).toBe(200);
    expect(await membershipOf(facility.id, email)).toMatchObject({
      roles: ["nurse"],
      licenceProfession: "nurse",
      licenceNumber: "NCK12345",
      licenceExpiresOn: expiresOn,
    });
  });

  it("refuses a licence nobody needs, an unclear profession, and a licence already lapsed", async () => {
    const facility = await makeFacility();
    const admin = await signedInUserAt(facility.id, ["facility_admin"]);
    const licence = { number: "A1234", expiresOn: addDays(businessDate(), 90) };
    const refusedAt = async (body: Record<string, unknown>) => {
      const res = await invite(facility.id, admin, { email: nextEmail(), name: "Someone Else", ...body });
      expect(res.status, JSON.stringify(body)).toBe(422);
      return (await res.json()).error.issues[0].path;
    };

    expect(await refusedAt({ roles: ["cashier"], licence })).toEqual(["licence"]);
    expect(await refusedAt({ roles: ["nurse", "pharm_tech"], licence })).toEqual(["licence", "profession"]);
    expect(await refusedAt({ roles: ["doctor"], licence: { ...licence, profession: "pharmacy" } })).toEqual(["licence", "profession"]);
    expect(await refusedAt({ roles: ["doctor"], licence: { ...licence, expiresOn: addDays(businessDate(), -1) } })).toEqual(["licence", "expiresOn"]);
    expect(await refusedAt({ roles: ["doctor"], licence: { ...licence, number: "A 12#4" } })).toEqual(["licence", "number"]);

    // Valid through its last day; an admin who is also a doctor is one profession.
    const lastDay = await invite(facility.id, admin, {
      email: nextEmail(),
      name: "Dr Kiprono",
      roles: ["facility_admin", "doctor"],
      licence: { ...licence, expiresOn: businessDate() },
    });
    expect(lastDay.status).toBe(201);
    expect((await lastDay.json()).licence.profession).toBe("medical_practitioner");
  });

  it("lets a nurse hold a pharmacy role under her nursing licence", async () => {
    const facility = await makeFacility();
    const admin = await signedInUserAt(facility.id, ["facility_admin"]);
    const licence = { profession: "nurse", number: "NCK55", expiresOn: addDays(businessDate(), 90) };

    const res = await invite(facility.id, admin, { email: nextEmail(), name: "Night Nurse", roles: ["nurse", "pharm_tech"], licence });

    expect(res.status).toBe(201);
    expect((await res.json()).licence).toEqual(licence);
  });

  it("brings a former clinical member back without a licence when no clinical role is offered", async () => {
    const facility = await makeFacility();
    const admin = await signedInUserAt(facility.id, ["facility_admin"]);
    const former = await signedInUser();
    await addMembership(former.id, facility.id, ["nurse"], { isActive: false });

    await invite(facility.id, admin, { email: former.email, name: "Former", roles: ["records_clerk"] });
    await drainOutbox();
    expect((await accept({ token: tokenFor(former.email) })).status).toBe(200);

    expect(await membershipOf(facility.id, former.email)).toMatchObject({ roles: ["records_clerk"], licenceNumber: null, licenceExpiresOn: null });
  });
});
