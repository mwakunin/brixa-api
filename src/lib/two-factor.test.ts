import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import app from "@/app";
import { DEV_BACKUP_CODES, developmentCode } from "@/dev/two-factor";
import { appOrigin, auth } from "@/lib/auth";
import { sentEmails } from "@/lib/email";
import {
  addMembership,
  cookieFrom,
  createTestAccount,
  facilityHeaders,
  makeFacility,
  nextEmail,
  nextIp,
  postJson,
  resetDb,
  signIn,
  TEST_PASSWORD,
} from "@/test/helpers";

/**
 * Two-step sign-in (SPEC.md §2, lib/auth.ts): after the password, a code from
 * an authenticator app or a printed backup code, at every sign-in. Nobody
 * skips it, and nobody works before setting it up.
 */

/** The password step: the cookie that names the challenge for a code. */
async function passwordStep(email: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await postJson("/api/auth/sign-in/email", { email, password: TEST_PASSWORD }, headers);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
  return cookieFrom(res.headers.get("set-cookie")!);
}

/** The code step, with a cookie, as the staff app sends it. */
function codeStep(cookie: string, body: Record<string, unknown>, route = "verify-totp", headers: Record<string, string> = {}): Promise<Response> {
  return postJson(`/api/auth/two-factor/${route}`, body, { cookie, origin: appOrigin, ...headers });
}

/** A six-digit code that is not the development authenticator's. */
async function wrongCode(): Promise<string> {
  return await developmentCode() === "123456" ? "654321" : "123456";
}

async function sessionOf(cookie: string): Promise<{ user: { id: string } } | null> {
  const res = await app.request("/api/auth/get-session", { headers: { cookie, "x-forwarded-for": nextIp() } });
  return res.json();
}

async function get(path: string, headers: Record<string, string>): Promise<Response> {
  return app.request(path, { headers: { "x-forwarded-for": nextIp(), ...headers } });
}

/** An authenticator secret as an otpauth:// URI carries it, in base32, back to the plain secret. */
function secretOf(totpURI: string): string {
  const encoded = new URL(totpURI).searchParams.get("secret")!;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes: number[] = [];
  let value = 0;
  let bits = 0;
  for (const ch of encoded.toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 255);
      value &= (1 << bits) - 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

describe("signing in with a code", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks for a code after the right password, and gives a session only once the code is right", async () => {
    const email = nextEmail();
    const person = await createTestAccount(email);
    const challenge = await passwordStep(email);
    expect(await sessionOf(challenge)).toBeNull();

    const wrong = await codeStep(challenge, { code: await wrongCode() });
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).code).toBe("INVALID_CODE");

    const right = await codeStep(challenge, { code: await developmentCode() });
    expect(right.status).toBe(200);
    expect((await sessionOf(cookieFrom(right.headers.get("set-cookie")!)))?.user.id).toBe(person.id);
  });

  it("takes a backup code instead, and each backup code once", async () => {
    const email = nextEmail();
    await createTestAccount(email);

    const first = await codeStep(await passwordStep(email), { code: DEV_BACKUP_CODES[0] }, "verify-backup-code");
    expect(first.status).toBe(200);
    expect(await sessionOf(cookieFrom(first.headers.get("set-cookie")!))).not.toBeNull();

    const again = await codeStep(await passwordStep(email), { code: DEV_BACKUP_CODES[0] }, "verify-backup-code");
    expect(again.status).toBe(401);
    expect((await again.json()).code).toBe("INVALID_BACKUP_CODE");
  });

  it("refuses to remember a computer, so the next sign-in asks for a code again", async () => {
    const email = nextEmail();
    await createTestAccount(email);
    const challenge = await passwordStep(email);

    const res = await codeStep(challenge, { code: await developmentCode(), trustDevice: true });

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("TRUST_DEVICE_NOT_ALLOWED");
    expect(res.headers.get("set-cookie") ?? "").not.toContain("trust_device");
    // The challenge still stands: the person can send the code without asking to be remembered.
    expect((await codeStep(challenge, { code: await developmentCode() })).status).toBe(200);
  });

  it("locks the account for fifteen minutes after five wrong codes in a row, from wherever they come", async () => {
    const email = nextEmail();
    await createTestAccount(email);
    const first = await passwordStep(email);
    for (let i = 0; i < 3; i += 1)
      expect((await codeStep(first, { code: await wrongCode() })).status).toBe(401);
    const second = await passwordStep(email);
    for (let i = 0; i < 2; i += 1)
      expect((await codeStep(second, { code: await wrongCode() })).status).toBe(401);

    const locked = await codeStep(await passwordStep(email), { code: await developmentCode() });
    expect(locked.status).toBe(429);
    expect((await locked.json()).code).toBe("ACCOUNT_TEMPORARILY_LOCKED");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 16 * 60_000);
    const later = await codeStep(await passwordStep(email), { code: await developmentCode() });
    expect(later.status).toBe(200);
  });

  it("ends a sign-in still waiting for its code when the password is reset", async () => {
    const email = nextEmail();
    await createTestAccount(email);
    const challenge = await passwordStep(email);
    await postJson("/api/auth/request-password-reset", { email });
    const link = new URL(sentEmails.at(-1)!.body.match(/https?:\/\/\S+/)![0]);
    expect((await postJson("/api/auth/reset-password", { token: link.searchParams.get("token"), newPassword: "a-brand-new-password" })).status).toBe(200);

    const res = await codeStep(challenge, { code: await developmentCode() });

    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("INVALID_TWO_FACTOR_COOKIE");
  });

  it("checks codes under their own address limit, which leaves the sign-in budget alone", async () => {
    const address = { "x-forwarded-for": nextIp() };
    const checks = await Promise.all(Array.from({ length: 30 }, () => postJson("/api/auth/two-factor/verify-totp", { code: "123456" }, address)));
    expect(checks.every(c => c.status === 401)).toBe(true);

    expect((await postJson("/api/auth/two-factor/verify-totp", { code: "123456" }, address)).status).toBe(429);
    const email = nextEmail();
    await createTestAccount(email);
    expect((await postJson("/api/auth/sign-in/email", { email, password: TEST_PASSWORD }, address)).status).toBe(200);
  });
});

describe("before an authenticator is set up", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("gives a session from the password alone, good for nothing here but setting one up", async () => {
    const email = nextEmail();
    const person = await createTestAccount(email, "New Starter", "user", { twoFactor: false });
    const facility = await makeFacility();
    await addMembership(person.id, facility.id, ["records_clerk"]);
    const { cookie } = await signIn(email);
    expect((await sessionOf(cookie))?.user.id).toBe(person.id);

    for (const res of [
      await get("/me/facilities", { cookie }),
      await get("/patients?q=Achieng", facilityHeaders(facility.id, { id: person.id, email, headers: { cookie } })),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ message: "Set up two-step sign-in before you start work.", code: "two_factor_setup_required" });
    }
    // Nobody signed in is still told so.
    expect((await get("/me/facilities", {})).status).toBe(401);
  });

  it("refuses the platform's own staff the same way", async () => {
    const email = nextEmail();
    await createTestAccount(email, "Platform Person", "superadmin", { twoFactor: false });
    const { cookie } = await signIn(email);

    const res = await get("/superadmin/facilities", { cookie });

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("two_factor_setup_required");
  });

  it("sets one up with the password, and lets the person work once its first code is right", async () => {
    const email = nextEmail();
    await createTestAccount(email, "New Starter", "user", { twoFactor: false });
    const { cookie } = await signIn(email);
    const headers = { cookie, origin: appOrigin };

    expect((await postJson("/api/auth/two-factor/enable", {}, headers)).status).toBe(400);
    const enabled = await postJson("/api/auth/two-factor/enable", { password: TEST_PASSWORD }, headers);
    expect(enabled.status).toBe(200);
    const { totpURI, backupCodes } = await enabled.json() as { totpURI: string; backupCodes: string[] };
    expect(totpURI).toMatch(/^otpauth:\/\/totp\/Brixa%20HMIS:/);
    expect(new URL(totpURI).searchParams.get("issuer")).toBe("Brixa HMIS");
    expect(backupCodes).toHaveLength(10);
    // Shown, not yet confirmed: still nothing but setting up.
    expect((await get("/me/facilities", { cookie })).status).toBe(403);

    const { code } = await auth.api.generateTOTP({ body: { secret: secretOf(totpURI) } });
    const confirmed = await postJson("/api/auth/two-factor/verify-totp", { code }, headers);
    expect(confirmed.status).toBe(200);
    const working = cookieFrom(confirmed.headers.get("set-cookie")!);

    expect((await get("/me/facilities", { cookie: working })).status).toBe(200);
    expect(sentEmails.at(-1)).toMatchObject({ to: email, subject: "Two-step sign-in is set up on your Brixa HMIS account" });
    // And from now on the password alone is not enough.
    expect((await (await postJson("/api/auth/sign-in/email", { email, password: TEST_PASSWORD })).json()).twoFactorRedirect).toBe(true);
  });

  it("is where turning it off sends the person back to, with a notice", async () => {
    const email = nextEmail();
    await createTestAccount(email);
    const { cookie } = await signIn(email);
    const headers = { cookie, origin: appOrigin };

    expect((await postJson("/api/auth/two-factor/disable", { password: "not-the-password" }, headers)).status).toBe(400);
    const off = await postJson("/api/auth/two-factor/disable", { password: TEST_PASSWORD }, headers);
    expect(off.status).toBe(200);

    const res = await get("/me/facilities", { cookie: cookieFrom(off.headers.get("set-cookie")!) });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("two_factor_setup_required");
    expect(sentEmails.at(-1)).toMatchObject({ to: email, subject: "Two-step sign-in was turned off on your Brixa HMIS account" });
  });
});
