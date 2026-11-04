import type { Context } from "hono";

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { AppOpenAPI, TenantBindings } from "@/lib/types";

import app from "@/app";
import db from "@/db";
import { auditLog } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { FACILITY_HEADER } from "@/lib/constants";
import { createTenantRouter, createTestApp } from "@/lib/create-app";
import { requireMembershipRole } from "@/middlewares/auth";
import { withFacility } from "@/middlewares/tenant";
import {
  addMembership,
  facilityHeaders,
  makeFacility,
  resetDb,
  signedInUser,
  signedInUserAt,
} from "@/test/helpers";

/**
 * Probe routes that exist only here: one writes and then fails without
 * throwing, one writes and succeeds, one is guarded by a role.
 */
const probe = createTenantRouter();
probe.use(withFacility);

async function writeEntry(c: Context<TenantBindings>) {
  await recordAudit(c.var.db, {
    facilityId: c.var.facility.id,
    actorId: c.var.user!.id,
    action: "membership.granted",
    entityType: "membership",
    entityId: c.var.membership.id,
    summary: "Probe entry",
  });
}

probe.post("/probe/write-then-fail", async (c) => {
  await writeEntry(c);
  return c.json({ message: "Refused after writing" }, 422);
});

probe.post("/probe/write", async (c) => {
  await writeEntry(c);
  return c.json({ ok: true }, 200);
});

probe.get("/probe/cashiers", requireMembershipRole("cashier"), c => c.json({ ok: true }, 200));

const probeApp = createTestApp(probe as unknown as AppOpenAPI);

/**
 * Tenant resolution end to end, over HTTP. `rls.test.ts` proves the database
 * refuses cross-tenant access even when the application forgets to ask; this
 * proves the application asks correctly: the header names the facility, the
 * membership there decides access, and the two combine so a request sees
 * exactly one facility.
 */
describe("withFacility", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("choosing the facility", () => {
    it("serves the facility named in the header, with my roles there", async () => {
      const alpha = await makeFacility({ name: "Alpha Hospital" });
      const person = await signedInUserAt(alpha.id, ["doctor", "facility_admin"]);

      const res = await app.request("/facility", { headers: facilityHeaders(alpha.id, person) });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id: alpha.id,
        name: "Alpha Hospital",
        kephLevel: 4,
        roles: ["doctor", "facility_admin"],
      });
    });

    it("ignores the hostname entirely", async () => {
      const alpha = await makeFacility();
      const beta = await makeFacility();
      const person = await signedInUserAt(alpha.id, ["nurse"]);

      // A host that looks like another tenant changes nothing: the header and
      // the membership decide.
      const res = await app.request("/facility", {
        headers: { ...facilityHeaders(alpha.id, person), host: `${beta.id}.example.test` },
      });

      expect(res.status).toBe(200);
      expect((await res.json()).id).toBe(alpha.id);
    });

    it("asks for a facility when the header is missing", async () => {
      const alpha = await makeFacility();
      const person = await signedInUserAt(alpha.id, ["nurse"]);

      const res = await app.request("/facility", { headers: person.headers });

      expect(res.status).toBe(400);
      expect((await res.json()).message).toContain(FACILITY_HEADER);
    });

    it("404s a header that is not a facility id, like any unknown facility", async () => {
      const alpha = await makeFacility();
      const person = await signedInUserAt(alpha.id, ["nurse"]);

      const res = await app.request("/facility", {
        headers: facilityHeaders("'; select 1; --", person),
      });

      expect(res.status).toBe(404);
    });

    it("404s a facility that does not exist", async () => {
      const alpha = await makeFacility();
      const person = await signedInUserAt(alpha.id, ["nurse"]);

      const res = await app.request("/facility", {
        headers: facilityHeaders("00000000-0000-4000-8000-000000000000", person),
      });

      expect(res.status).toBe(404);
    });

    it("tells a suspended facility's staff why, rather than 404ing them", async () => {
      const alpha = await makeFacility({ status: "suspended" });
      const person = await signedInUserAt(alpha.id, ["facility_admin"]);

      const res = await app.request("/facility", { headers: facilityHeaders(alpha.id, person) });

      expect(res.status).toBe(403);
      expect((await res.json()).message).toMatch(/suspended/i);
    });
  });

  describe("membership", () => {
    it("401s a request with no session", async () => {
      const alpha = await makeFacility();

      const res = await app.request("/facility", { headers: facilityHeaders(alpha.id) });

      expect(res.status).toBe(401);
    });

    it("404s a signed-in user with no membership there", async () => {
      const alpha = await makeFacility();
      const outsider = await signedInUser();

      const res = await app.request("/facility", { headers: facilityHeaders(alpha.id, outsider) });

      // 404, not 403: otherwise anyone with an account could enumerate which
      // facility ids are real customers.
      expect(res.status).toBe(404);
    });

    it("answers a stranger at a suspended facility with 404, not the suspension", async () => {
      const alpha = await makeFacility({ status: "suspended" });
      const outsider = await signedInUser();

      const res = await app.request("/facility", { headers: facilityHeaders(alpha.id, outsider) });

      expect(res.status).toBe(404);
    });

    it("404s an inactive membership", async () => {
      const alpha = await makeFacility();
      const former = await signedInUser();
      await addMembership(former.id, alpha.id, ["nurse"], { isActive: false });

      const res = await app.request("/facility", { headers: facilityHeaders(alpha.id, former) });

      expect(res.status).toBe(404);
    });

    it("does not carry a membership at one facility over to another", async () => {
      const alpha = await makeFacility();
      const beta = await makeFacility();
      const person = await signedInUserAt(alpha.id, ["facility_admin"]);

      const atAlpha = await app.request("/facility", { headers: facilityHeaders(alpha.id, person) });
      const atBeta = await app.request("/facility", { headers: facilityHeaders(beta.id, person) });

      expect(atAlpha.status).toBe(200);
      expect(atBeta.status).toBe(404);
    });

    it("lets one login work at two facilities, with different roles at each", async () => {
      const alpha = await makeFacility();
      const beta = await makeFacility();
      const locum = await signedInUserAt(alpha.id, ["doctor"]);
      await addMembership(locum.id, beta.id, ["clinical_officer"]);

      const atAlpha = await app.request("/facility", { headers: facilityHeaders(alpha.id, locum) });
      const atBeta = await app.request("/facility", { headers: facilityHeaders(beta.id, locum) });

      expect((await atAlpha.json()).roles).toEqual(["doctor"]);
      expect((await atBeta.json()).roles).toEqual(["clinical_officer"]);
    });
  });

  describe("the request transaction", () => {
    it("commits what a successful handler wrote", async () => {
      const alpha = await makeFacility();
      const person = await signedInUserAt(alpha.id, ["facility_admin"]);

      const res = await probeApp.request("/probe/write", {
        method: "POST",
        headers: facilityHeaders(alpha.id, person),
      });

      expect(res.status).toBe(200);
      const rows = await db.select().from(auditLog).where(eq(auditLog.facilityId, alpha.id));
      expect(rows).toHaveLength(1);
    });

    it("rolls back what a handler wrote before returning an error status", async () => {
      const alpha = await makeFacility();
      const person = await signedInUserAt(alpha.id, ["facility_admin"]);

      const res = await probeApp.request("/probe/write-then-fail", {
        method: "POST",
        headers: facilityHeaders(alpha.id, person),
      });

      // The handler's response stands; its write does not.
      expect(res.status).toBe(422);
      expect((await res.json()).message).toBe("Refused after writing");
      const rows = await db.select().from(auditLog).where(eq(auditLog.facilityId, alpha.id));
      expect(rows).toEqual([]);
    });
  });
});

describe("requireMembershipRole", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("admits a member holding the role", async () => {
    const alpha = await makeFacility();
    const cashier = await signedInUserAt(alpha.id, ["cashier"]);

    const res = await probeApp.request("/probe/cashiers", { headers: facilityHeaders(alpha.id, cashier) });

    expect(res.status).toBe(200);
  });

  it("gives a member without the role an honest 403", async () => {
    const alpha = await makeFacility();
    const doctor = await signedInUserAt(alpha.id, ["doctor"]);

    const res = await probeApp.request("/probe/cashiers", { headers: facilityHeaders(alpha.id, doctor) });

    expect(res.status).toBe(403);
  });

  it("admits a member holding the role among others", async () => {
    const alpha = await makeFacility();
    const both = await signedInUserAt(alpha.id, ["records_clerk", "cashier"]);

    const res = await probeApp.request("/probe/cashiers", { headers: facilityHeaders(alpha.id, both) });

    expect(res.status).toBe(200);
  });

  it("does not honour a role held at a different facility", async () => {
    const alpha = await makeFacility();
    const beta = await makeFacility();
    const person = await signedInUserAt(alpha.id, ["doctor"]);
    await addMembership(person.id, beta.id, ["cashier"]);

    const res = await probeApp.request("/probe/cashiers", { headers: facilityHeaders(alpha.id, person) });

    expect(res.status).toBe(403);
  });
});
