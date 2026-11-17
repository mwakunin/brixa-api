import { beforeEach, describe, expect, it } from "vitest";

import app from "@/app";
import db from "@/db";
import { user } from "@/db/schema";
import { AccountExistsError } from "@/lib/accounts";
import { appOrigin, auth } from "@/lib/auth";
import { sentEmails } from "@/lib/email";
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
});
