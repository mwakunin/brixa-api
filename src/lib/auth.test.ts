import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import app from "@/app";
import db from "@/db";
import { user } from "@/db/schema";
import { AccountExistsError } from "@/lib/accounts";
import { appOrigin, auth, logForBetterAuth, RESET_REQUEST_ANSWER_MS } from "@/lib/auth";
import { sentEmails } from "@/lib/email";
import { logger } from "@/lib/logger";
import { createTestAccount, nextEmail, nextIp, postJson, resetDb, signIn, TEST_PASSWORD } from "@/test/helpers";

/**
 * Accounts are invite-only (lib/auth.ts): a hospital's staff are known to it,
 * so nobody may create an account by visiting the sign-up endpoint.
 */
describe("accounts", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("refuses public sign-up and creates no user", async () => {
    const res = await postJson("/api/auth/sign-up/email", {
      email: nextEmail(),
      password: "correct-horse-battery",
      name: "Stranger",
    });

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("EMAIL_PASSWORD_SIGN_UP_DISABLED");
    expect(await db.select().from(user)).toEqual([]);
  });

  it("signs in an account created on the server", async () => {
    const email = nextEmail();
    await createTestAccount(email);

    const res = await postJson("/api/auth/sign-in/email", { email, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("session_token");
  });

  it("finishes an account a failed run left without a password, instead of colliding with it", async () => {
    const email = nextEmail();
    // What a run that died between its two writes leaves behind.
    const context = await auth.$context;
    await context.internalAdapter.createUser({ email, name: "Half Made", emailVerified: true }, { method: "admin" });

    await createTestAccount(email);

    const res = await postJson("/api/auth/sign-in/email", { email, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    // A finished account is not made twice.
    await expect(createTestAccount(email)).rejects.toBeInstanceOf(AccountExistsError);
  });

  it("refuses a wrong password", async () => {
    const email = nextEmail();
    await createTestAccount(email);

    const res = await postJson("/api/auth/sign-in/email", { email, password: "not-the-password" });

    expect(res.status).toBe(401);
  });
});

/**
 * A forgotten password is reset by email (lib/auth.ts): the link goes to the
 * staff app, works for an hour and once, and resetting ends every session.
 */
describe("resetting a forgotten password", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const NEW_PASSWORD = "a-brand-new-password";

  function requestReset(email: string) {
    return postJson("/api/auth/request-password-reset", { email });
  }

  /** The link in the last email sent. */
  function lastLink(): URL {
    const found = sentEmails.at(-1)?.body.match(/https?:\/\/\S+/);
    if (!found)
      throw new Error("no link was emailed");
    return new URL(found[0]);
  }

  it("emails a link to the staff app's reset page, which works for an hour", async () => {
    const email = nextEmail();
    await createTestAccount(email);
    const asked = Date.now();

    const res = await requestReset(email);

    expect(res.status).toBe(200);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].to).toBe(email);
    const link = lastLink();
    expect(link.origin).toBe(appOrigin);
    expect(link.pathname).toBe("/reset-password");
    const context = await auth.$context;
    const stored = await context.internalAdapter.findVerificationValue(`reset-password:${link.searchParams.get("token")}`);
    const lasts = stored!.expiresAt.getTime() - asked;
    expect(lasts).toBeGreaterThan(59 * 60_000);
    expect(lasts).toBeLessThanOrEqual(61 * 60_000);
  });

  it("answers an address with no account exactly as one with an account, and sends nothing", async () => {
    const known = nextEmail();
    await createTestAccount(known);
    const forKnown = await requestReset(known);
    sentEmails.length = 0;

    const forUnknown = await requestReset(nextEmail());

    expect(forUnknown.status).toBe(forKnown.status);
    expect(await forUnknown.json()).toEqual(await forKnown.json());
    expect(sentEmails).toEqual([]);
  });

  it("takes the same fixed time to answer either, so the wait does not tell who has an account", async () => {
    const known = nextEmail();
    await createTestAccount(known);

    for (const email of [known, nextEmail()]) {
      const asked = performance.now();
      await requestReset(email);
      // A timer may fire a millisecond early.
      expect(performance.now() - asked, email).toBeGreaterThanOrEqual(RESET_REQUEST_ANSWER_MS - 2);
    }
  });

  it("refuses a request over the rate limit at once, since a refusal says nothing about the address", async () => {
    const oneAddress = { "x-forwarded-for": "10.77.0.1" };
    await Promise.all(Array.from({ length: 10 }, () => postJson("/api/auth/request-password-reset", { email: nextEmail() }, oneAddress)));

    const asked = performance.now();
    const refused = await postJson("/api/auth/request-password-reset", { email: nextEmail() }, oneAddress);

    expect(refused.status).toBe(429);
    expect(performance.now() - asked).toBeLessThan(RESET_REQUEST_ANSWER_MS / 2);
  });

  it("sets the new password, ends every session the person had, and tells them", async () => {
    const email = nextEmail();
    await createTestAccount(email);
    const elsewhere = await signIn(email);
    await requestReset(email);

    const res = await postJson("/api/auth/reset-password", { token: lastLink().searchParams.get("token"), newPassword: NEW_PASSWORD });

    expect(res.status).toBe(200);
    expect((await postJson("/api/auth/sign-in/email", { email, password: TEST_PASSWORD })).status).toBe(401);
    expect((await postJson("/api/auth/sign-in/email", { email, password: NEW_PASSWORD })).status).toBe(200);
    const session = await app.request("/api/auth/get-session", { headers: { "cookie": elsewhere.cookie, "x-forwarded-for": nextIp() } });
    expect(await session.json()).toBeNull();
    expect(sentEmails.at(-1)).toMatchObject({ to: email, subject: "Your Brixa HMIS password was changed" });
    expect(sentEmails.at(-1)!.body).toContain("tell your administrator");
  });

  it("refuses a link that has been used", async () => {
    const email = nextEmail();
    await createTestAccount(email);
    await requestReset(email);
    const token = lastLink().searchParams.get("token");
    await postJson("/api/auth/reset-password", { token, newPassword: NEW_PASSWORD });

    const again = await postJson("/api/auth/reset-password", { token, newPassword: "yet-another-password" });

    expect(again.status).toBe(400);
    expect((await again.json()).code).toBe("INVALID_TOKEN");
    expect((await postJson("/api/auth/sign-in/email", { email, password: NEW_PASSWORD })).status).toBe(200);
  });

  it("lets only one of two resets sent at once with the same link through", async () => {
    const email = nextEmail();
    await createTestAccount(email);
    await requestReset(email);
    const token = lastLink().searchParams.get("token");
    const passwords = ["first-new-password", "second-new-password"];

    const answers = await Promise.all(passwords.map(newPassword => postJson("/api/auth/reset-password", { token, newPassword })));

    expect(answers.map(a => a.status).sort()).toEqual([200, 400]);
    const [won, lost] = answers[0].status === 200 ? passwords : [...passwords].reverse();
    expect((await postJson("/api/auth/sign-in/email", { email, password: won })).status).toBe(200);
    expect((await postJson("/api/auth/sign-in/email", { email, password: lost })).status).toBe(401);
  });

  /*
   * A sign-in reads the stored password, checks it (slowly, by design), then
   * creates a session. One that read the old password just before a reset
   * committed would create its session after the reset had signed everyone
   * out. The race cannot be timed reliably here, so the sign-in's clock is
   * set back instead: to the API, it began before the password changed.
   */
  it("refuses a session to a sign-in that began before the password changed", async () => {
    const email = nextEmail();
    await createTestAccount(email);
    await requestReset(email);
    await postJson("/api/auth/reset-password", { token: lastLink().searchParams.get("token"), newPassword: NEW_PASSWORD });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 5_000);
    const begunBefore = await postJson("/api/auth/sign-in/email", { email, password: NEW_PASSWORD });
    vi.useRealTimers();

    expect(begunBefore.status).toBe(401);
    expect(begunBefore.headers.get("set-cookie") ?? "").not.toContain("session_token");
    // One begun now, after the change, signs in.
    expect((await postJson("/api/auth/sign-in/email", { email, password: NEW_PASSWORD })).status).toBe(200);
  });

  it("refuses a link after its hour, leaving the password and the person's sessions as they were", async () => {
    const email = nextEmail();
    await createTestAccount(email);
    const signedIn = await signIn(email);
    await requestReset(email);
    const token = lastLink().searchParams.get("token");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61 * 60_000);
    const late = await postJson("/api/auth/reset-password", { token, newPassword: NEW_PASSWORD });
    vi.useRealTimers();

    expect(late.status).toBe(400);
    expect((await late.json()).code).toBe("INVALID_TOKEN");
    expect((await postJson("/api/auth/sign-in/email", { email, password: TEST_PASSWORD })).status).toBe(200);
    const session = await app.request("/api/auth/get-session", { headers: { "cookie": signedIn.cookie, "x-forwarded-for": nextIp() } });
    expect(await session.json()).not.toBeNull();
  });
});

/**
 * Better Auth logs an unexpected error whole, and a database error's message
 * carries its SQL parameters: a reset token, an address. Its log lines go
 * through the process's logger, cut as errorLine cuts them (rule 10).
 */
describe("the log lines Better Auth writes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const failedLookup = "Failed query: select \"value\" from \"verification\" where \"identifier\" = $1\nparams: reset-password:secret-token-123";

  it("keep a database error's first line and drop its parameters", () => {
    const written = vi.spyOn(logger, "error").mockImplementation(() => {});

    logForBetterAuth("error", "Error", new Error(failedLookup));
    logForBetterAuth("error", failedLookup);

    const lines = JSON.stringify(written.mock.calls);
    expect(lines).toContain("Failed query: select");
    expect(lines).not.toContain("secret-token-123");
  });

  it("are where Better Auth writes", async () => {
    const written = vi.spyOn(logger, "warn").mockImplementation(() => {});
    await resetDb();
    const email = nextEmail();
    await createTestAccount(email);

    await postJson("/api/auth/sign-in/email", { email, password: "not-the-password" });

    expect(written).toHaveBeenCalledWith({ source: "better-auth" }, "Invalid password");
  });
});
