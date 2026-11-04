import type { KeyObject } from "node:crypto";

import { OAuth2Client } from "google-auth-library";
import { Buffer } from "node:buffer";
import { createSign, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import app from "@/app";
import { DRAIN_PATH, INVOKER_AUDIENCE } from "@/lib/cloud-tasks";
import { createTestApp } from "@/lib/create-app";
import { sentEmails } from "@/lib/email";
import { googleInvokerVerifier } from "@/lib/invoker-auth";
import { postJson, resetDb, signedInUser } from "@/test/helpers";

import { createInternalRouter } from "./internal.route";

/**
 * Identity tokens shaped exactly as Google's, signed with a key of our own
 * that the verifier is told is Google's. Everything else about verification
 * (signature, issuer, audience, expiry) is the library's real code.
 */
const INVOKER = "tasks-invoker@hms-test.iam.gserviceaccount.com";
const KID = "test-key";

const google = generateKeyPairSync("rsa", { modulusLength: 2048 });
const impostor = generateKeyPairSync("rsa", { modulusLength: 2048 });

function base64url(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function token(claims: Record<string, unknown> = {}, key: KeyObject = google.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url({ alg: "RS256", kid: KID, typ: "JWT" })}.${base64url({
    iss: "https://accounts.google.com",
    aud: INVOKER_AUDIENCE,
    sub: "1234567890",
    email: INVOKER,
    email_verified: true,
    iat: now,
    exp: now + 300,
    ...claims,
  })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key).toString("base64url");
  return `${unsigned}.${signature}`;
}

/** The library's own response shape; its format enum is not exported. */
type CertsResponse = Awaited<ReturnType<OAuth2Client["getFederatedSignonCertsAsync"]>>;

function verifier() {
  const client = new OAuth2Client();
  client.getFederatedSignonCertsAsync = async () => ({
    certs: { [KID]: google.publicKey.export({ type: "spki", format: "pem" }).toString() },
    format: "PEM",
  }) as CertsResponse;
  return googleInvokerVerifier({ audience: INVOKER_AUDIENCE, allowedEmails: new Set([INVOKER]), client });
}

describe("the invoker check", () => {
  it("accepts a token Google signed for this API and the configured account", async () => {
    expect(await verifier().verify(`Bearer ${token()}`)).toBe(true);
  });

  it.each([
    ["minted for another audience", { aud: "https://elsewhere.example" }],
    ["for another account", { email: "someone@hms-test.iam.gserviceaccount.com" }],
    ["with an unverified address", { email_verified: false }],
    ["from another issuer", { iss: "https://evil.example" }],
    ["that has expired", { exp: Math.floor(Date.now() / 1000) - 600, iat: Math.floor(Date.now() / 1000) - 900 }],
  ])("refuses a token %s", async (_label, claims) => {
    expect(await verifier().verify(`Bearer ${token(claims)}`)).toBe(false);
  });

  it("refuses a token Google did not sign", async () => {
    expect(await verifier().verify(`Bearer ${token({}, impostor.privateKey)}`)).toBe(false);
  });

  it.each([undefined, "", "Basic abc", "Bearer", "Bearer not a token"])("refuses the header %j", async (header) => {
    expect(await verifier().verify(header)).toBe(false);
  });

  it("refuses everyone when no account is configured", async () => {
    const closed = googleInvokerVerifier({ audience: INVOKER_AUDIENCE, allowedEmails: new Set() });

    expect(await closed.verify(`Bearer ${token()}`)).toBe(false);
  });
});

describe("the drain route", () => {
  const internal = createTestApp(createInternalRouter(verifier()));

  beforeEach(async () => {
    await resetDb();
  });

  function drain(authorization?: string) {
    return internal.request(DRAIN_PATH, { method: "POST", headers: authorization ? { authorization } : {} });
  }

  it("refuses a call without a valid token", async () => {
    expect((await drain()).status).toBe(401);
    expect((await drain(`Bearer ${token({ email: "someone@else.example" })}`)).status).toBe(401);
  });

  it("drains the outbox for Cloud Tasks and Cloud Scheduler", async () => {
    // Onboarding queues the first admin's invitation email.
    const superadmin = await signedInUser({ role: "superadmin" });
    await postJson("/superadmin/facilities", {
      name: "Amani Hospital",
      kmhfrCode: "54321",
      kephLevel: 4,
      numbering: { outpatientPrefix: "OPD", nextOutpatientNumber: 1 },
      admin: { name: "Wanjiru Kamau", email: "admin@example.test" },
    }, superadmin.headers);

    const res = await drain(`Bearer ${token()}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ done: 1, skipped: 0, retried: 0, failed: 0 });
    expect(sentEmails.map(m => m.to)).toEqual(["admin@example.test"]);
  });

  it("is closed in the real app until an invoker is configured", async () => {
    const res = await app.request(DRAIN_PATH, { method: "POST", headers: { authorization: `Bearer ${token()}` } });

    expect(res.status).toBe(401);
  });
});
