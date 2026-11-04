import { beforeEach, describe, expect, it } from "vitest";

import app from "@/app";
import { appOrigin } from "@/lib/auth";
import { nextIp, resetDb, signedInUser } from "@/test/helpers";

/**
 * The staff app runs at its own origin and calls this API with the session
 * cookie. Its origin, and no other, may do so (lib/create-app.ts, lib/auth.ts).
 */
describe("the staff app's origin", () => {
  beforeEach(async () => {
    await resetDb();
  });

  function preflight(origin: string) {
    return app.request("/staff/invitations", {
      method: "OPTIONS",
      headers: {
        "origin": origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, x-facility-id",
      },
    });
  }

  it("is answered a credentialed preflight that allows the facility header", async () => {
    const res = await preflight(appOrigin);

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(appOrigin);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("x-facility-id");
  });

  it("is the only origin granted cross-origin access", async () => {
    const res = await preflight("https://evil.example");

    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("may make a cookie-bearing auth request, where another origin may not", async () => {
    // Better Auth's CSRF defence checks the origin of a request carrying a cookie.
    const signOut = async (origin: string) => {
      const person = await signedInUser();
      return app.request("/api/auth/sign-out", {
        method: "POST",
        headers: { ...person.headers, "origin": origin, "x-forwarded-for": nextIp(), "content-type": "application/json" },
        body: "{}",
      });
    };

    expect((await signOut(appOrigin)).status).toBe(200);
    expect((await signOut("https://evil.example")).status).toBe(403);
  });
});
