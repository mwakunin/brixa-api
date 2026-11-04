import { beforeEach, describe, expect, it } from "vitest";

import app from "@/app";
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
});
