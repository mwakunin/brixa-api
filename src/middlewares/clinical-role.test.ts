import { beforeEach, describe, expect, it } from "vitest";

import type { AppOpenAPI } from "@/lib/types";

import { createTenantRouter, createTestApp } from "@/lib/create-app";
import { addDays, businessDate, printedDate } from "@/lib/dates";
import { addMembership, facilityHeaders, makeFacility, resetDb, signedInUser } from "@/test/helpers";

import { requireClinicalRole } from "./auth";
import { withFacility } from "./tenant";

/** A stand-in for a clinical act: only a doctor or a clinical officer, licensed today. */
const router = createTenantRouter();
router.use(withFacility);
router.get("/clinical-act", requireClinicalRole("doctor", "clinical_officer"), c => c.json({ ok: true }));
const app = createTestApp(router as unknown as AppOpenAPI);

async function personAt(facilityId: string, roles: Parameters<typeof addMembership>[2], expiresOn?: string) {
  const person = await signedInUser();
  await addMembership(person.id, facilityId, roles, expiresOn ? { licence: { number: "A1", expiresOn } } : {});
  return person;
}

describe("a clinical act's licence check", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("lets a licensed clinician act, through the licence's last day", async () => {
    const facility = await makeFacility();
    const doctor = await personAt(facility.id, ["doctor"], businessDate());

    const res = await app.request("/clinical-act", { headers: facilityHeaders(facility.id, doctor) });

    expect(res.status).toBe(200);
  });

  it("refuses a clinician whose licence has lapsed, saying when and who can help", async () => {
    const facility = await makeFacility();
    const yesterday = addDays(businessDate(), -1);
    const officer = await personAt(facility.id, ["clinical_officer", "facility_admin"], yesterday);

    const res = await app.request("/clinical-act", { headers: facilityHeaders(facility.id, officer) });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("licence_expired");
    expect(body.message).toContain(printedDate(yesterday));
    expect(body.message).toContain("facility admin");
  });

  it("refuses a role it does not name, licence or not", async () => {
    const facility = await makeFacility();
    const nurse = await personAt(facility.id, ["nurse"]);

    const res = await app.request("/clinical-act", { headers: facilityHeaders(facility.id, nurse) });

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBeUndefined();
  });
});
