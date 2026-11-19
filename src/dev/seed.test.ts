import { beforeEach, describe, expect, it } from "vitest";

import db from "@/db";
import { effectiveHost } from "@/db/connection";
import { facilities, user } from "@/db/schema";
import { loadDrugCatalogue } from "@/lib/drug-catalogue-load";
import { makeFacility, resetDb, signIn } from "@/test/helpers";

import { remoteConnections, SEED_PASSWORD, SEED_STAFF, seedDevelopment } from "./seed";

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
      // The password, then the development authenticator's code, as every seeded account signs in.
      const { cookie } = await signIn(email, SEED_PASSWORD);
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

    // The staff app's facility picker: the relief clerk works at three, one of them suspended.
    const relief = await (await as(SEED_STAFF.relief.email))("/me/facilities");
    expect(relief.facilities.map((f: { name: string; status: string; roles: string[] }) => [f.name, f.status, [...f.roles].sort()])).toEqual([
      ["Sample Hospital", "active", ["records_clerk"]],
      ["Sample Hospital, East", "suspended", ["records_clerk"]],
      ["Sample Hospital, Westside", "active", ["cashier", "records_clerk"]],
    ]);

    await expect(seedDevelopment()).rejects.toThrow(/seeded already/);
  });

  it("finds the medicines it stocks before writing anything, and stops there if the catalogue lacks one", async () => {
    await loadDrugCatalogue("code,generic_name,strength,form,dose_unit,route,controlled_schedule\nAMX-500-CAP,Amoxicillin,500 mg,Capsule,capsule,oral,\n");

    await expect(seedDevelopment()).rejects.toThrow(/The drug catalogue has no Artemether\/Lumefantrine 20 mg\/120 mg Tablet/);

    expect(await db.select().from(user)).toEqual([]);
    expect(await db.select().from(facilities)).toEqual([]);
  });

  it("writes only to databases on this machine, through every connection it uses", () => {
    expect(remoteConnections({ owner: "localhost", app: "127.0.0.1", auth: "/var/run/postgresql" })).toEqual([]);
    expect(remoteConnections({ owner: "localhost", app: "::1", auth: "db.example.com" })).toEqual(["auth (db.example.com)"]);
    // PGHOST could be anywhere.
    expect(remoteConnections({ owner: "localhost", app: null, auth: "localhost" })).toEqual(["app (no host named)"]);
    expect(remoteConnections({ owner: effectiveHost("postgresql://u:p@localhost/db?host=remote.example"), app: "localhost", auth: "localhost" })).toEqual(["owner (remote.example)"]);
  });

  it("refuses a database holding any facility, as one tunnelled to localhost from elsewhere would, before writing anything", async () => {
    await makeFacility({ name: "A real hospital" });

    await expect(seedDevelopment()).rejects.toThrow(/holds a facility already/);

    expect(await db.select().from(user)).toEqual([]);
  });
});
