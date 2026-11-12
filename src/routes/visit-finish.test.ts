import { eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { Hospital, StaffMember } from "@/test/hospital";

import app from "@/app";
import db, { pool } from "@/db";
import { auditLog, encounters } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import { closeFinishedVisits } from "@/jobs/visits";
import { loadDrugCatalogue } from "@/lib/drug-catalogue-load";
import { finishedVisits } from "@/lib/visit-finish";
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

  it("finds a finished visit behind any number of older ones that still owe", async () => {
    const owing = await visit();
    await call("POST", `/encounters/${owing.encounterId}/charges`, h.facility.id, h.clerk, { billableItemId: h.items.consultation, quantity: "1", reason: "Before P3" });
    const finished = await visit();

    // One candidate at a time, so the owing visit fills the first page.
    const ids = await runAsFacility(h.facility.id, async tx => finishedVisits(tx, 1));

    expect(ids).toEqual([finished.encounterId]);
  });

  it("pages past older visits that owe, however finely their times differ", async () => {
    const owing = [await visit(), await visit()];
    for (const v of owing)
      await call("POST", `/encounters/${v.encounterId}/charges`, h.facility.id, h.clerk, { billableItemId: h.items.consultation, quantity: "1", reason: "Before P3" });
    const finished = await visit();
    // Both owing visits start at the same instant, to the microsecond; the finished one after.
    await pool.query("UPDATE encounters SET started_at = '2026-01-01 08:00:00.123456+03' WHERE id = ANY($1)", [owing.map(v => v.encounterId)]);
    await pool.query("UPDATE encounters SET started_at = '2026-01-01 08:00:00.123789+03' WHERE id = $1", [finished.encounterId]);

    const ids = await runAsFacility(h.facility.id, async tx => finishedVisits(tx, 1));

    expect(ids).toEqual([finished.encounterId]);
  }, 30_000);

  it("resolves, after a run cut short at its limit, only the failures of the visits it listed", async () => {
    const first = await visit();
    const second = await visit();
    await pool.query(
      `INSERT INTO job_failures (facility_id, job, subject_id, error, failed_at) VALUES
         ($1, 'visit_finish', $2, 'first failed', now() - interval '1 hour'),
         ($1, 'visit_finish', $3, 'second failed', now() - interval '1 hour'),
         ($1, 'visit_finish', NULL, 'listing failed', now() - interval '1 hour')`,
      [h.facility.id, first.encounterId, second.encounterId],
    );
    const open = async () => (await pool.query<{ error: string }>("SELECT error FROM job_failures WHERE resolved_at IS NULL ORDER BY error")).rows.map(r => r.error);

    expect(await closeFinishedVisits(1)).toMatchObject({ closed: 1, failed: 0 });
    expect(await open()).toEqual(["listing failed", "second failed"]);
    expect(await closeFinishedVisits()).toMatchObject({ closed: 1, failed: 0 });
    expect(await open()).toEqual([]);
  });

  it("waits for a paid-for test until its result is out", async () => {
    const { patientId, encounterId } = await visit();
    const order = await (await call("POST", `/encounters/${encounterId}/orders`, h.facility.id, doctor, { items: [{ labTestId: mrdt.id }] })).json();
    const bill = await (await call("POST", `/encounters/${encounterId}/bill-now`, h.facility.id, h.cashier)).json();
    await call("POST", "/payments", h.facility.id, h.cashier, { patientId, method: "bank", reference: "BANK 0002", amountCents: bill.totalCents, invoiceId: bill.id });

    expect(await closeFinishedVisits()).toMatchObject({ closed: 0 });
    const specimen = await (await call("POST", `/orders/${order.id}/specimens`, h.facility.id, labTech, { specimenType: "blood" })).json();
    expect(await closeFinishedVisits()).toMatchObject({ closed: 0 });
    const result = await (await call("POST", `/specimens/${specimen.id}/results`, h.facility.id, labTech, {
      orderItemId: order.items[0].id,
      values: [{ analyteId: mrdt.analyteId, value: "Negative" }],
    })).json();
    expect(await closeFinishedVisits()).toMatchObject({ closed: 0 });
    await call("POST", `/lab-results/${result.id}/verify`, h.facility.id, supervisor, {});

    expect(await closeFinishedVisits()).toMatchObject({ closed: 1 });
  });

  it("is checked by Cloud Scheduler alone", async () => {
    expect((await app.request("/internal/jobs/finish-visits", { method: "POST" })).status).toBe(401);
  });
});
