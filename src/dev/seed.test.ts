import { beforeEach, describe, expect, it } from "vitest";

import { resetDb } from "@/test/helpers";

import { SEED_PASSWORD, SEED_STAFF, seedDevelopment } from "./seed";

/** `pnpm db:seed` (`src/dev/seed.ts`): a made-up hospital, every desk with someone at it. */

describe("the development seed", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("fills every outpatient desk, through the API, once", async () => {
    const seeded = await seedDevelopment();
    expect(seeded.staff).toHaveLength(Object.keys(SEED_STAFF).length);

    const { default: app } = await import("@/app");
    let ip = 0;
    async function as(email: string) {
      ip += 1;
      const res = await app.request("/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `10.253.0.${ip}` }, body: JSON.stringify({ email, password: SEED_PASSWORD }) });
      expect(res.status, email).toBe(200);
      const cookie = res.headers.get("set-cookie")!.split(/,(?=\s*[^;=\s]+=)/).map(c => c.split(";")[0].trim()).join("; ");
      return async (route: string) => {
        ip += 1;
        const answer = await app.request(route, { headers: { cookie, "x-facility-id": seeded.facilityId, "x-forwarded-for": `10.253.0.${ip}` } });
        expect(answer.status, route).toBe(200);
        return answer.json();
      };
    }

    const doctor = await as(SEED_STAFF.doctor.email);
    const points = (await doctor("/service-points")).servicePoints as { id: string; name: string; waiting: number }[];
    expect(points.map(p => [p.name, p.waiting])).toEqual([["Triage", 2], ["Dental clinic", 0], ["General OPD", 2]]);
    const clinic = await doctor(`/service-points/${points.find(p => p.name === "General OPD")!.id}/queue`);
    expect(clinic.entries.map((e: { patient: { name: string }; returnedWithResults: boolean }) => [e.patient.name, e.returnedWithResults]))
      .toEqual(expect.arrayContaining([["Amina Njeri", false], ["Mary Chebet", true]]));
    expect((await doctor("/results-to-review")).results).toHaveLength(2);

    const lab = await (await as(SEED_STAFF.labTech.email))("/lab/worklist");
    expect([lab.toCollect.length, lab.toVerify.length]).toEqual([1, 1]);
    const pharmacy = await (await as(SEED_STAFF.pharmacist.email))("/pharmacy/worklist");
    // Ruth's medicine is prepared and still to give, so she is on both lists until it is handed over.
    expect(pharmacy.waiting.map((w: { patient: { name: string }; medicines: { prepared: boolean }[] }) => [w.patient.name, w.medicines[0].prepared]))
      .toEqual(expect.arrayContaining([["Brian Kiplagat", false], ["Ruth Akinyi", true]]));
    expect(pharmacy.prepared.map((p: { patient: { name: string } }) => p.patient.name)).toEqual(["Ruth Akinyi"]);
    const due = await (await as(SEED_STAFF.cashier.email))("/cashier/due");
    expect(due.visits.length).toBeGreaterThanOrEqual(4);
    const booked = await (await as(SEED_STAFF.clerk.email))(`/appointments`);
    expect(booked.appointments).toEqual([expect.objectContaining({ patient: expect.objectContaining({ name: "Peter Otieno" }), status: "booked" })]);

    await expect(seedDevelopment()).rejects.toThrow(/seeded already/);
  });
});
