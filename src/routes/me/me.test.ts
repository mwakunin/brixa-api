import { beforeEach, describe, expect, it } from "vitest";

import app from "@/app";
import { addMembership, makeFacility, resetDb, signedInUser, signedInUserAt } from "@/test/helpers";

describe("the facility picker, /me/facilities", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("401s without a session", async () => {
    const res = await app.request("/me/facilities");

    expect(res.status).toBe(401);
  });

  it("lists my active memberships by facility name, with my roles at each", async () => {
    const zawadi = await makeFacility({ name: "Zawadi Hospital" });
    const amani = await makeFacility({ name: "Amani Hospital" });
    const person = await signedInUserAt(zawadi.id, ["doctor"]);
    await addMembership(person.id, amani.id, ["clinical_officer", "facility_admin"]);

    const res = await app.request("/me/facilities", { headers: person.headers });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      facilities: [
        { id: amani.id, name: "Amani Hospital", status: "active", roles: ["clinical_officer", "facility_admin"] },
        { id: zawadi.id, name: "Zawadi Hospital", status: "active", roles: ["doctor"] },
      ],
    });
  });

  it("shows a suspended facility, so the user can see why they are locked out", async () => {
    const closed = await makeFacility({ name: "Closed Hospital", status: "suspended" });
    const person = await signedInUserAt(closed.id, ["nurse"]);

    const res = await app.request("/me/facilities", { headers: person.headers });

    expect((await res.json()).facilities).toEqual([
      expect.objectContaining({ id: closed.id, status: "suspended" }),
    ]);
  });

  it("leaves out inactive memberships and everyone else's", async () => {
    const alpha = await makeFacility();
    const beta = await makeFacility();
    const person = await signedInUser();
    await addMembership(person.id, alpha.id, ["nurse"], { isActive: false });
    // Someone else's membership at a facility I have nothing to do with.
    await signedInUserAt(beta.id, ["facility_admin"]);

    const res = await app.request("/me/facilities", { headers: person.headers });

    expect(await res.json()).toEqual({ facilities: [] });
  });
});
