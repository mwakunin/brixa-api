import { asc, eq, sql } from "drizzle-orm";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import app from "@/app";
import db, { appPool, authDb, authPool, withAdvisoryLock } from "@/db";
import { session, signInEvents, twoFactor } from "@/db/schema";
import { DEV_BACKUP_CODES, developmentCode } from "@/dev/two-factor";
import { appOrigin, auth, twoFactorChangeKey } from "@/lib/auth";
import { businessDate } from "@/lib/dates";
import { pgErrorCode } from "@/lib/db-errors";
import { sentEmails } from "@/lib/email";
import { logger } from "@/lib/logger";
import { LOCK_SECONDS } from "@/middlewares/sign-in-lock";
import { cookieFrom, createTestAccount, nextEmail, nextIp, postJson, resetDb, signedInUser, signIn, TEST_PASSWORD } from "@/test/helpers";
import { decodeSecret } from "@/test/two-factor-secret";

import { EXPORT_PAGE_ROWS, signInEventsCsv } from "./sign-in-support";

/**
 * The sign-in log (SPEC.md §2, lib/sign-in-log.ts) and the lock on wrong
 * passwords (middlewares/sign-in-lock.ts): regulation 12's log of login
 * attempts and password changes, and its limit on failed logins.
 */

const INSUFFICIENT_PRIVILEGE = "42501";
const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";

async function events() {
  const rows = await db.select().from(signInEvents).orderBy(asc(signInEvents.at), asc(signInEvents.id));
  return rows.map(({ event, userId, actorId, factor, note }) => ({ event, userId, actorId, factor, note }));
}

function password(email: string, given: string, address = nextIp()) {
  return postJson("/api/auth/sign-in/email", { email, password: given }, { "x-forwarded-for": address });
}

async function challenge(email: string): Promise<string> {
  return cookieFrom((await password(email, TEST_PASSWORD)).headers.get("set-cookie")!);
}

function code(cookie: string, given: string, route = "verify-totp") {
  return postJson(`/api/auth/two-factor/${route}`, { code: given }, { cookie, origin: appOrigin });
}

async function wrongCode(): Promise<string> {
  return await developmentCode() === "123456" ? "654321" : "123456";
}

async function errorFrom(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  }
  catch (err) {
    return err;
  }
  throw new Error("Expected the statement to be refused, but it succeeded");
}

describe("the sign-in log", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records a wrong password under its account, and under nobody for an address with no account, with where each came from", async () => {
    const email = nextEmail();
    const person = await createTestAccount(email);

    await postJson("/api/auth/sign-in/email", { email, password: "not-the-password" }, { "x-forwarded-for": "10.9.0.1", "user-agent": "TestBrowser/1.0" });
    await password(nextEmail(), "not-the-password");

    const rows = await db.select().from(signInEvents).orderBy(asc(signInEvents.at));
    expect(rows[0]).toMatchObject({ event: "password_failed", userId: person.id, factor: "password", ipAddress: "10.9.0.1", userAgent: "TestBrowser/1.0" });
    expect(rows[1]).toMatchObject({ event: "password_failed", userId: null, factor: "password" });
    expect(rows).toHaveLength(2);
  });

  it("records the password accepted, then the sign-in with the factor that finished it", async () => {
    const email = nextEmail();
    const person = await createTestAccount(email);

    await signIn(email);
    expect((await code(await challenge(email), DEV_BACKUP_CODES[0], "verify-backup-code")).status).toBe(200);

    expect(await events()).toEqual([
      { event: "password_accepted", userId: person.id, actorId: null, factor: "password", note: null },
      { event: "signed_in", userId: person.id, actorId: null, factor: "totp", note: null },
      { event: "password_accepted", userId: person.id, actorId: null, factor: "password", note: null },
      { event: "signed_in", userId: person.id, actorId: null, factor: "backup_code", note: null },
    ]);
  });

  it("records each wrong code, the lock once at the fifth, and a try while locked", async () => {
    const email = nextEmail();
    const person = await createTestAccount(email);
    const waiting = await challenge(email);
    for (let i = 0; i < 5; i += 1)
      await code(waiting, await wrongCode());
    await code(await challenge(email), await developmentCode());

    const logged = (await events()).filter(e => e.event !== "password_accepted");
    expect(logged.map(e => e.event)).toEqual(["code_failed", "code_failed", "code_failed", "code_failed", "code_failed", "locked", "refused_locked"]);
    expect(logged.every(e => e.userId === person.id && e.factor === "totp")).toBe(true);
  });

  it("records an authenticator set up, without counting its new session as a sign-in, and turned off", async () => {
    const email = nextEmail();
    const person = await createTestAccount(email, "New Starter", "user", { twoFactor: false });
    const { cookie } = await signIn(email);
    const headers = { cookie, origin: appOrigin };
    const { totpURI } = await (await postJson("/api/auth/two-factor/enable", { password: TEST_PASSWORD }, headers)).json() as { totpURI: string };
    const first = await auth.api.generateTOTP({ body: { secret: decodeSecret(totpURI) } });
    const confirmed = await postJson("/api/auth/two-factor/verify-totp", { code: first.code }, headers);
    await postJson("/api/auth/two-factor/disable", { password: TEST_PASSWORD }, { cookie: cookieFrom(confirmed.headers.get("set-cookie")!), origin: appOrigin });

    expect((await events()).map(e => [e.event, e.factor])).toEqual([
      ["signed_in", "password"],
      ["two_factor_enabled", null],
      ["two_factor_disabled", null],
    ]);
    expect((await events()).every(e => e.userId === person.id)).toBe(true);
  });

  it("records a password reset, a password changed, and signing out", async () => {
    const email = nextEmail();
    const person = await createTestAccount(email);
    await postJson("/api/auth/request-password-reset", { email });
    const link = new URL(sentEmails.at(-1)!.body.match(/https?:\/\/\S+/)![0]);
    await postJson("/api/auth/reset-password", { token: link.searchParams.get("token"), newPassword: "a-brand-new-password" });
    const { cookie } = await signIn(email, "a-brand-new-password");
    const headers = { cookie, origin: appOrigin };
    expect((await postJson("/api/auth/change-password", { currentPassword: "a-brand-new-password", newPassword: "another-new-password" }, headers)).status).toBe(200);
    expect((await postJson("/api/auth/sign-out", {}, headers)).status).toBe(200);

    expect((await events()).map(e => e.event)).toEqual(["password_reset", "password_accepted", "signed_in", "password_changed", "signed_out"]);
    expect((await events()).every(e => e.userId === person.id)).toBe(true);
  });

  /*
   * A wrong code and a right one sent with the same challenge: the right one
   * can spend the challenge before the wrong one's answer is recorded. The
   * wrong one's person was found before either ran.
   */
  it("records a wrong code even when a right one spends its challenge first", async () => {
    const email = nextEmail();
    const person = await createTestAccount(email);
    const waiting = await challenge(email);
    const { adapter } = await auth.$context;
    const increment = adapter.incrementOne.bind(adapter);
    let hasFailed!: () => void;
    const failing = new Promise<void>((resolve) => {
      hasFailed = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The wrong code is held as it counts its failure, after its answer is decided.
    const spy = vi.spyOn(adapter, "incrementOne").mockImplementationOnce((async (query: Parameters<typeof increment>[0]) => {
      hasFailed();
      await released;
      return increment(query);
    }) as unknown as typeof adapter.incrementOne);

    const wrong = code(waiting, await wrongCode());
    await failing;
    const right = await code(waiting, await developmentCode());
    release();
    const refused = await wrong;
    spy.mockRestore();

    expect(right.status).toBe(200);
    expect(refused.status).toBe(401);
    expect((await events()).filter(e => e.event === "code_failed")).toEqual([
      { event: "code_failed", userId: person.id, actorId: null, factor: "totp", note: null },
    ]);
  });

  it("sets an authenticator up even when its event cannot be written, and says so in the log", async () => {
    const email = nextEmail();
    await createTestAccount(email, "New Starter", "user", { twoFactor: false });
    const headers = { cookie: (await signIn(email)).cookie, origin: appOrigin };
    const { totpURI } = await (await postJson("/api/auth/two-factor/enable", { password: TEST_PASSWORD }, headers)).json() as { totpURI: string };
    const { code: first } = await auth.api.generateTOTP({ body: { secret: decodeSecret(totpURI) } });
    const logged = vi.spyOn(logger, "error").mockImplementation(() => {});
    const insert = authDb.insert.bind(authDb);
    const unreachable = vi.spyOn(authDb, "insert").mockImplementation(((table: Parameters<typeof insert>[0]) => {
      if (table === signInEvents)
        throw new Error("the log cannot be reached");
      return insert(table);
    }) as typeof authDb.insert);

    const confirmed = await postJson("/api/auth/two-factor/verify-totp", { code: first }, headers);
    unreachable.mockRestore();

    expect(confirmed.status).toBe(200);
    const me = await app.request("/me/facilities", { headers: { "cookie": cookieFrom(confirmed.headers.get("set-cookie")!), "x-forwarded-for": nextIp() } });
    expect(me.status).toBe(200);
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ event: "two_factor_enabled" }), "Could not record a sign-in event");
  });

  // The log looks the account up after Better Auth has answered; that lookup failing must not change the answer.
  it("answers a sign-in as it would have when a lookup made for the log fails", async () => {
    const email = nextEmail();
    await createTestAccount(email);
    const logged = vi.spyOn(logger, "error").mockImplementation(() => {});
    const { internalAdapter } = await auth.$context;
    const find = internalAdapter.findUserByEmail.bind(internalAdapter);
    let calls = 0;
    vi.spyOn(internalAdapter, "findUserByEmail").mockImplementation(async (...args: Parameters<typeof find>) => {
      calls += 1;
      // Better Auth's own lookup comes first; the log's is the second.
      if (calls === 2)
        throw new Error("the lookup cannot be made");
      return find(...args);
    });

    const res = await password(email, "not-the-password");

    expect(res.status).toBe(401);
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(Object) }), "Could not record a sign-in event");
  });

  it("is append-only for every role, written by Better Auth's alone, and read by no runtime role", async () => {
    const email = nextEmail();
    await createTestAccount(email);
    await password(email, "not-the-password");

    for (const statement of ["UPDATE sign_in_events SET event = 'signed_in'", "DELETE FROM sign_in_events", "TRUNCATE sign_in_events"])
      expect(pgErrorCode(await errorFrom(() => db.execute(sql.raw(statement)))), statement).toBe(RESTRICT_VIOLATION);
    for (const statement of ["SELECT * FROM sign_in_events", "INSERT INTO sign_in_events (event) VALUES ('signed_in')"])
      expect(pgErrorCode(await errorFrom(() => appPool.query(statement))), statement).toBe(INSUFFICIENT_PRIVILEGE);
    expect(pgErrorCode(await errorFrom(() => authPool.query("SELECT * FROM sign_in_events")))).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe("the lock on wrong passwords", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("locks the account from that address after five wrong passwords in a row, refusing even the right one, and logs it", async () => {
    const email = nextEmail();
    await createTestAccount(email);
    const address = nextIp();
    for (let i = 0; i < 5; i += 1)
      expect((await password(email, "not-the-password", address)).status).toBe(401);

    const refused = await password(email, TEST_PASSWORD, address);

    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ code: "sign_in_locked", message: expect.stringContaining("15 minutes") });
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(LOCK_SECONDS - 60);
    expect((await events()).map(e => e.event)).toEqual([...Array.from({ length: 5 }, () => "password_failed"), "locked", "refused_locked"]);
  });

  it("leaves the owner signing in from somewhere else", async () => {
    const email = nextEmail();
    await createTestAccount(email);
    const attacker = nextIp();
    for (let i = 0; i < 5; i += 1)
      await password(email, "not-the-password", attacker);

    expect((await password(email, TEST_PASSWORD)).status).toBe(200);
  });

  /*
   * Better Auth reads a form-encoded sign-in too, but the account keys read
   * JSON alone: such a sign-in would count against no account, and pass the
   * lock. It is refused before anything else.
   */
  it("refuses a sign-in that is not JSON, so a locked account cannot be tried as a form", async () => {
    const email = nextEmail();
    await createTestAccount(email);
    const address = nextIp();
    for (let i = 0; i < 5; i += 1)
      await password(email, "not-the-password", address);

    const asForm = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": address },
      body: new URLSearchParams({ email, password: TEST_PASSWORD }).toString(),
    });

    expect(asForm.status).toBe(415);
    expect((await asForm.json()).code).toBe("unsupported_media_type");
    expect((await password(email, TEST_PASSWORD, address)).status).toBe(429);
  });

  it("counts wrong passwords in a row: a right one starts the count again", async () => {
    const email = nextEmail();
    await createTestAccount(email);
    const address = nextIp();
    for (let i = 0; i < 4; i += 1)
      await password(email, "not-the-password", address);
    expect((await password(email, TEST_PASSWORD, address)).status).toBe(200);
    for (let i = 0; i < 4; i += 1)
      await password(email, "not-the-password", address);

    expect((await password(email, TEST_PASSWORD, address)).status).toBe(200);
  });
});

describe("the export of the log, for Brixa support", () => {
  beforeEach(async () => {
    await resetDb();
  });

  function exportFor(headers: Record<string, string>, from: string, to: string) {
    return app.request(`/superadmin/sign-in-events?from=${from}&to=${to}`, { headers: { "x-forwarded-for": nextIp(), ...headers } });
  }

  it("gives the log between two Nairobi dates as CSV, and records the export", async () => {
    const support = await signedInUser({ role: "superadmin" });
    const email = nextEmail();
    await createTestAccount(email, "Achieng Otieno");
    await password(email, "not-the-password");
    const today = businessDate();

    const res = await exportFor(support.headers, today, today);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain(`sign-in-log-${today}-to-${today}.csv`);
    const lines = (await res.text()).trim().split("\r\n");
    expect(lines[0]).toBe("\"at (Nairobi time)\",\"event\",\"factor\",\"name\",\"email\",\"by\",\"note\",\"ip_address\",\"user_agent\"");
    expect(lines.some(line => line.includes("\"password_failed\",\"password\",\"Achieng Otieno\"") && line.includes(email))).toBe(true);
    expect((await events()).at(-1)).toEqual({ event: "log_exported", userId: null, actorId: support.id, factor: null, note: `${today} to ${today}` });
  });

  /*
   * A long range is read a page at a time, so the API holds one page of it
   * however many events it covers. Events that share a time, or differ by a
   * microsecond, are neither repeated nor lost where one page ends.
   */
  it("sends a long range a page at a time, every event once and oldest first", async () => {
    const support = await signedInUser({ role: "superadmin" });
    const count = EXPORT_PAGE_ROWS * 2 + 500;
    await db.execute(sql`
      INSERT INTO sign_in_events (event, factor, at, user_agent)
      SELECT 'password_failed', 'password', '2026-01-15 10:00:00.123456+03'::timestamptz + (g % 7) * interval '1 microsecond', 'agent ' || g
      FROM generate_series(1, ${count}) AS g`);

    const res = await exportFor(support.headers, "2026-01-15", "2026-01-15");

    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let chunks = 0;
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      chunks += 1;
      text += decoder.decode(read.value, { stream: true });
    }
    const agents = text.trim().split("\r\n").slice(1).map(line => Number(line.split(",").at(-1)!.replace(/\D/g, "")));
    expect(chunks).toBeGreaterThanOrEqual(3);
    expect(agents).toHaveLength(count);
    expect(new Set(agents).size).toBe(count);
    // Oldest first: the microsecond each was given never goes back.
    expect(agents.map(g => g % 7)).toEqual(agents.map(g => g % 7).sort((a, b) => a - b));
  });

  it("allows each member of support ten exports an hour", async () => {
    const support = await signedInUser({ role: "superadmin" });
    const today = businessDate();

    for (let i = 0; i < 10; i += 1)
      expect((await exportFor(support.headers, today, today)).status).toBe(200);
    const refused = await exportFor(support.headers, today, today);

    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(60);
  });

  it("refuses anyone but platform staff, and a range backwards or longer than a year", async () => {
    const support = await signedInUser({ role: "superadmin" });
    const someone = await signedInUser();

    expect((await exportFor(someone.headers, "2026-01-01", "2026-03-31")).status).toBe(403);
    expect((await exportFor(support.headers, "2026-03-31", "2026-01-01")).status).toBe(422);
    expect((await exportFor(support.headers, "2025-01-01", "2026-03-31")).status).toBe(422);
  });

  it("opens with an apostrophe any cell a spreadsheet would take for a formula", () => {
    const csv = signInEventsCsv([{ at: new Date("2026-11-19T05:00:00Z"), event: "signed_in", factor: "totp", name: "=HYPERLINK(\"http://x\")", email: "a@b.test", actorEmail: null, note: null, ipAddress: null, userAgent: "-cmd" }]);

    expect(csv.split("\r\n")[0]).toBe("\"2026-11-19 08:00:00\",\"signed_in\",\"totp\",\"'=HYPERLINK(\"\"http://x\"\")\",\"a@b.test\",\"\",\"\",\"\",\"'-cmd\"");
  });

  // Some spreadsheets read the full-width signs as the plain ones.
  it("opens a cell starting with a full-width formula sign with an apostrophe too", () => {
    const csv = signInEventsCsv([{ at: new Date("2026-11-19T05:00:00Z"), event: "two_factor_reset", factor: null, name: "\uFF0B254", email: "a@b.test", actorEmail: "\uFF20support", note: "\uFF1DSUM(A1)", ipAddress: null, userAgent: "\uFF0Dcmd" }]);

    expect(csv.split("\r\n")[0]).toBe("\"2026-11-19 08:00:00\",\"two_factor_reset\",\"\",\"'\uFF0B254\",\"a@b.test\",\"'\uFF20support\",\"'\uFF1DSUM(A1)\",\"\",\"'\uFF0Dcmd\"");
  });
});

describe("resetting someone's two-step sign-in, by Brixa support", () => {
  beforeEach(async () => {
    await resetDb();
  });

  const reason = "Lost phone and codes; checked by a video call with their facility admin present.";

  function reset(headers: Record<string, string>, body: Record<string, unknown>) {
    return postJson("/superadmin/two-factor-resets", body, headers);
  }

  it("removes their authenticator, ends every session, logs support's reason, and tells them", async () => {
    const support = await signedInUser({ role: "superadmin" });
    const person = await signedInUser({ name: "Achieng Otieno" });

    const res = await reset(support.headers, { email: person.email, reason });

    expect(res.status).toBe(200);
    const session = await app.request("/api/auth/get-session", { headers: { ...person.headers, "x-forwarded-for": nextIp() } });
    expect(await session.json()).toBeNull();
    // The password alone now signs in, to set an authenticator up again and nothing else.
    const { cookie } = await signIn(person.email);
    const me = await app.request("/me/facilities", { headers: { cookie, "x-forwarded-for": nextIp() } });
    expect((await me.json()).code).toBe("two_factor_setup_required");
    expect((await events()).find(e => e.event === "two_factor_reset")).toEqual({ event: "two_factor_reset", userId: person.id, actorId: support.id, factor: null, note: reason });
    expect(sentEmails.find(m => m.to === person.email && m.subject === "Your Brixa HMIS two-step sign-in was reset")).toBeDefined();
  });

  /*
   * A code check already under way when support resets the person: it has
   * spent its challenge and is about to make its session. The reset writes
   * the time a password change would, so the session is refused.
   */
  it("refuses a session to a code check under way when support resets the person", async () => {
    const support = await signedInUser({ role: "superadmin" });
    const email = nextEmail();
    const person = await createTestAccount(email);
    const waiting = await challenge(email);
    const { internalAdapter } = await auth.$context;
    const spend = internalAdapter.consumeVerificationValue.bind(internalAdapter);
    let resetAnswer: Response | undefined;
    const spy = vi.spyOn(internalAdapter, "consumeVerificationValue").mockImplementation(async (identifier) => {
      const spent = await spend(identifier);
      if (identifier.startsWith("2fa-") && !identifier.startsWith("2fa-attempts-") && !resetAnswer) {
        await sleep(5);
        resetAnswer = await reset(support.headers, { email, reason });
      }
      return spent;
    });

    const res = await code(waiting, await developmentCode());
    spy.mockRestore();

    expect(resetAnswer?.status).toBe(200);
    expect(res.ok).toBe(false);
    expect(await db.select().from(session).where(eq(session.userId, person.id))).toEqual([]);
  });

  /*
   * Setting an authenticator up runs under the person's two-factor lock
   * (lib/auth.ts). A reset in the middle of it would let the setup turn
   * two-step sign-in back on with no authenticator left to check a code.
   */
  it("refuses a reset while a change to the person's two-step sign-in is under way, to be tried again", async () => {
    const support = await signedInUser({ role: "superadmin" });
    const person = await signedInUser();

    const during = await withAdvisoryLock(twoFactorChangeKey(person.id), () => reset(support.headers, { email: person.email, reason }));

    expect(during.held).toBe(true);
    const refused = during.held ? during.value : null;
    expect(refused?.status).toBe(409);
    expect(await refused?.json()).toMatchObject({ code: "TWO_FACTOR_CHANGE_UNDER_WAY" });
    expect(await db.select().from(twoFactor).where(eq(twoFactor.userId, person.id))).toHaveLength(1);
    expect((await reset(support.headers, { email: person.email, reason })).status).toBe(200);
  });

  // Support's acts wait for their events (lib/sign-in-support.ts), unlike a sign-in, which has already happened.
  it("refuses a reset or an export whose event cannot be written, and changes nothing", async () => {
    const support = await signedInUser({ role: "superadmin" });
    const person = await signedInUser();
    const today = businessDate();
    await db.execute(sql`
      CREATE FUNCTION refuse_support_events() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated failure'; END; $$;
      CREATE TRIGGER refuse_support_events BEFORE INSERT ON sign_in_events
        FOR EACH ROW WHEN (NEW.event IN ('two_factor_reset', 'log_exported')) EXECUTE FUNCTION refuse_support_events();
    `);
    try {
      expect((await reset(support.headers, { email: person.email, reason })).status).toBe(500);
      const exported = await app.request(`/superadmin/sign-in-events?from=${today}&to=${today}`, { headers: { "x-forwarded-for": nextIp(), ...support.headers } });
      expect(exported.status).toBe(500);
    }
    finally {
      await db.execute(sql`DROP TRIGGER refuse_support_events ON sign_in_events; DROP FUNCTION refuse_support_events();`);
    }

    expect(await db.select().from(twoFactor).where(eq(twoFactor.userId, person.id))).toHaveLength(1);
    expect(await db.select().from(session).where(eq(session.userId, person.id))).not.toEqual([]);
    expect(sentEmails.some(m => m.to === person.email && m.subject === "Your Brixa HMIS two-step sign-in was reset")).toBe(false);
  });

  it("will not record a reset without the person it was for", async () => {
    const support = await signedInUser({ role: "superadmin" });

    const err = await errorFrom(() => db.insert(signInEvents).values({ event: "two_factor_reset", actorId: support.id, note: reason }));

    expect(pgErrorCode(err)).toBe(CHECK_VIOLATION);
  });

  it("refuses one's own, an address with no account, and a reset without a reason", async () => {
    const support = await signedInUser({ role: "superadmin" });
    const someone = await signedInUser();

    const own = await reset(support.headers, { email: support.email, reason });
    expect(own.status).toBe(409);
    expect((await own.json()).code).toBe("own_account");
    expect((await reset(support.headers, { email: nextEmail(), reason })).status).toBe(404);
    expect((await reset(support.headers, { email: someone.email, reason: "asked" })).status).toBe(422);
    expect((await reset(someone.headers, { email: support.email, reason })).status).toBe(403);
  });
});
