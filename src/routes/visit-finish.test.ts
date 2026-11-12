import { eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { Hospital, StaffMember } from "@/test/hospital";

import app from "@/app";
import db from "@/db";
import { auditLog, encounters } from "@/db/schema";
import { closeFinishedVisits } from "@/jobs/visits";
import { loadDrugCatalogue } from "@/lib/drug-catalogue-load";
import { addMembership, resetDb, signedInUser } from "@/test/helpers";
import { call, hospital, TODAY } from "@/test/hospital";

/** P3 slice 5b: a visit closing itself once nothing is pending. */

let h: Hospital;
let doctor: StaffMember;
let labTech: StaffMember;
let supervisor: StaffMember;
let mrdt: { id: string; analyteId: string };

async function staff(roles: Parameters<typeof addMembership>[2]): Promise<StaffMember> {
  const user = await signedInUser();
  const membership = await addMembership(user.id, h.facility.id, roles);
  return { ...user, actor: { userId: user.id, membershipId: membership.id } };
}

beforeEach(async () => {
  await resetDb();
  await loadDrugCatalogue(await readFile(path.resolve(import.meta.dirname, "../test/fixtures/drug-catalogue-sample.csv"), "utf8"));
  h = await hospital();
  doctor = await staff(["doctor"]);
  labTech = await staff(["lab_tech"]);
  supervisor = await staff(["lab_supervisor"]);
  // The facility's one triage point, which every visit joins as it opens.
  await call("POST", "/service-points", h.facility.id, h.admin, { name: "Triage", kind: "triage" });
  const item = (await (await call("POST", "/billable-items", h.facility.id, h.admin, { code: "MRDT", name: "Malaria RDT", category: "lab" })).json()).id;
  const change = await (await call("POST", "/price-changes", h.facility.id, h.admin, { effectiveFrom: TODAY, reason: "Tariff", lines: [{ billableItemId: item, unitPriceCents: 30_000 }] })).json();
  await call("POST", `/price-changes/${change.id}/approve`, h.facility.id, h.finance);
  const test = await (await call("POST", "/lab-tests", h.facility.id, h.admin, {
    billableItemId: item,
    specimenType: "blood",
    analytes: [{ code: "MPS", name: "Malaria parasites", resultType: "choice", choices: ["Negative", "Positive"] }],
  })).json();
  mrdt = { id: test.id, analyteId: test.analytes[0].id };
});

/** A visit at triage; `seen` finishes the patient there. */
async function visit(seen = true) {
  const patientId = await h.patient();
  const opened = await (await call("POST", "/encounters", h.facility.id, h.nurse, { patientId, kind: "opd" })).json();
  if (seen) {
    await call("POST", `/queue-entries/${opened.queue.entryId}/serve`, h.facility.id, h.nurse);
    await call("POST", `/queue-entries/${opened.queue.entryId}/finish`, h.facility.id, h.nurse, { priority: "routine" });
  }
  return { patientId, encounterId: opened.id as string };
}

async function status(encounterId: string) {
  return (await db.select().from(encounters).where(eq(encounters.id, encounterId)))[0];
}

describe("a visit with nothing pending", () => {
  it("closes itself, by nobody, once the patient was seen and owes nothing", async () => {
    const seen = await visit();
    const justOpened = await visit(false);

    expect(await closeFinishedVisits()).toMatchObject({ closed: 1, failed: 0 });

    expect(await status(seen.encounterId)).toMatchObject({ status: "closed", closedBy: null });
    // Waiting at triage, and nothing done yet: left open.
    expect((await status(justOpened.encounterId)).status).toBe("open");
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.summary, "Closed by itself: nothing was left pending"));
    expect(entry).toMatchObject({ actorId: null, entityId: seen.encounterId });
    expect(await closeFinishedVisits()).toMatchObject({ closed: 0 });
  });

  it("waits for its lab test to be resulted and paid for, but not for a medicine to be dispensed", async () => {
    const { patientId, encounterId } = await visit();
    const order = await (await call("POST", `/encounters/${encounterId}/orders`, h.facility.id, doctor, { items: [{ labTestId: mrdt.id }] })).json();
    await call("POST", `/encounters/${encounterId}/prescriptions`, h.facility.id, doctor, { items: [{ drugCode: "PCM-500-TAB", doseAmount: "1", frequency: "tds", durationDays: 3 }] });

    expect(await closeFinishedVisits()).toMatchObject({ closed: 0 });
    const specimen = await (await call("POST", `/orders/${order.id}/specimens`, h.facility.id, labTech, { specimenType: "blood" })).json();
    expect(await closeFinishedVisits()).toMatchObject({ closed: 0 });
    const result = await (await call("POST", `/specimens/${specimen.id}/results`, h.facility.id, labTech, {
      orderItemId: order.items[0].id,
      values: [{ analyteId: mrdt.analyteId, value: "Negative" }],
    })).json();
    expect(await closeFinishedVisits()).toMatchObject({ closed: 0 });
    await call("POST", `/lab-results/${result.id}/verify`, h.facility.id, supervisor, {});

    // Resulted, but the test is not paid for: the cashier's list still shows the visit.
    expect(await closeFinishedVisits()).toMatchObject({ closed: 0 });
    const bill = await (await call("POST", `/encounters/${encounterId}/bill-now`, h.facility.id, h.cashier)).json();
    await call("POST", "/payments", h.facility.id, h.cashier, { patientId, method: "bank", reference: "BANK 0001", amountCents: bill.totalCents, invoiceId: bill.id });

    expect(await closeFinishedVisits()).toMatchObject({ closed: 1 });
    expect((await status(encounterId)).status).toBe("closed");
  });

  it("is checked by Cloud Scheduler alone", async () => {
    expect((await app.request("/internal/jobs/finish-visits", { method: "POST" })).status).toBe(401);
  });
});
