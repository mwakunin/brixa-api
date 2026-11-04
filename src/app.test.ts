import { beforeEach, describe, expect, it } from "vitest";

import app from "@/app";
import { appOrigin } from "@/lib/auth";
import { resetDb, signedInUser } from "@/test/helpers";

/**
 * Every tenant router registers `withFacility` at `/*` on the parent app, so
 * the routes outside any facility stay outside it only because they are
 * mounted first and answer without calling `next()` (src/app.ts). One mounted
 * after the tenant routers would silently start demanding an X-Facility-Id.
 * These requests carry no facility header and must never see that 400.
 */
describe("routes outside any facility", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it.each(["/", "/health", "/doc"])("serves %s with no session and no facility", async (path) => {
    const res = await app.request(path);

    expect(res.status).toBe(200);
  });

  it("serves the facility picker to a signed-in user with no facility chosen", async () => {
    const person = await signedInUser();

    const res = await app.request("/me/facilities", { headers: person.headers });

    expect(res.status).toBe(200);
  });

  it("serves the internal routes to nobody without a token, rather than asking for a facility", async () => {
    const res = await app.request("/internal/outbox/drain", { method: "POST" });

    expect(res.status).toBe(401);
  });
});

describe("every response", () => {
  function expectHardened(res: Response) {
    // Encryption in transit (docs/certification/encryption.md).
    expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // The staff app's site may read what this API returns; other sites may not.
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-site");
  }

  it("tells browsers to use HTTPS only, and hardens the rest", async () => {
    expectHardened(await app.request("/health"));
  });

  // A preflight is answered by the CORS middleware without going further.
  it("includes a CORS preflight", async () => {
    const res = await app.request("/staff/invitations", {
      method: "OPTIONS",
      headers: { "origin": appOrigin, "access-control-request-method": "POST" },
    });

    expect(res.status).toBe(204);
    expectHardened(res);
  });
});
