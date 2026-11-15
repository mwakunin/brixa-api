import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { Hospital, StaffMember } from "@/test/hospital";

import app from "@/app";
import db from "@/db";
import { auditLog, charges, encounters, mpesaSettings } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import { closeFinishedVisits } from "@/jobs/visits";
import { darajaTimestamp } from "@/lib/daraja";
import { loadDrugCatalogue } from "@/lib/drug-catalogue-load";
import { loadIcd11 } from "@/lib/icd11-load";
import { reconcile } from "@/lib/reconciliation";
import { addMembership, resetDb, signedInUser } from "@/test/helpers";
import { call, hospital, TODAY } from "@/test/hospital";

/**
 * The P3 exit (ROADMAP.md P3, slice 8): a day's outpatients, through the API
 * as the staff app would drive it, with no charge posted by hand and the
 * money reconciling at the end. Dispensing joins in P4.
 *
 * - Amina pays as she goes, in cash: registration, triage, the clinic, a
 *   lab test, the clinic again with her result, and a printed prescription.
 * - Baraka comes on an appointment and pays the final bill by M-Pesa paybill.
 * - Chebet is a walk-in for the lab, sent by an outside doctor.
 */

const FIXTURES = path.resolve(import.meta.dirname, "../test/fixtures");

let h: Hospital;
let doctor: StaffMember;
let labTech: StaffMember;
let supervisor: StaffMember;
let gopd: string;
let mrdt: { testId: string; analyteId: string };
let token: string;

async function staff(roles: Parameters<typeof addMembership>[2]): Promise<StaffMember> {
  const user = await signedInUser();
  const membership = await addMembership(user.id, h.facility.id, roles);
  return { ...user, actor: { userId: user.id, membershipId: membership.id } };
}

async function api(method: string, route: string, who: StaffMember, body?: unknown, status = method === "GET" ? 200 : undefined) {
  const res = await call(method, route, h.facility.id, who, body);
  if (status)
    expect(res.status, `${method} ${route}`).toBe(status);
  else
    expect(res.status, `${method} ${route}`).toBeLessThan(300);
  return res.json();
}

beforeEach(async () => {
  await resetDb();
  await loadIcd11(await readFile(path.join(FIXTURES, "icd11-mms-sample.txt"), "utf8"));
  await loadDrugCatalogue(await readFile(path.join(FIXTURES, "drug-catalogue-sample.csv"), "utf8"));
  h = await hospital();
  doctor = await staff(["doctor"]);
  labTech = await staff(["lab_tech"]);
  supervisor = await staff(["lab_supervisor"]);

  // The facility's set-up: a triage desk, a clinic with its fee, a malaria test, M-Pesa and the cashier's shift.
  await api("POST", "/service-points", h.admin, { name: "Triage", kind: "triage" });
  gopd = (await api("POST", "/service-points", h.admin, { name: "General OPD", kind: "consultation" })).id;
  await api("PATCH", `/service-points/${gopd}`, h.admin, { consultationItemId: h.items.consultation });
  const item = (await api("POST", "/billable-items", h.admin, { code: "MRDT", name: "Malaria rapid test", category: "lab" })).id;
  const change = await api("POST", "/price-changes", h.admin, { effectiveFrom: TODAY, reason: "Tariff", lines: [{ billableItemId: item, unitPriceCents: 30_000 }] });
  await api("POST", `/price-changes/${change.id}/approve`, h.finance);
  const test = await api("POST", "/lab-tests", h.admin, {
    billableItemId: item,
    specimenType: "blood",
    analytes: [{ code: "MPS", name: "Malaria parasites", resultType: "choice", choices: ["Negative", "Positive"], abnormalChoices: ["Positive"] }],
  });
  mrdt = { testId: test.id, analyteId: test.analytes[0].id };
  await api("PUT", "/mpesa/settings", h.admin, { shortcode: "600123", consumerKey: "consumer-key-1", consumerSecret: "consumer-secret-1", passkey: "stk-passkey-1" });
  [{ callbackToken: token }] = await db.select({ callbackToken: mpesaSettings.callbackToken }).from(mpesaSettings);
  await api("POST", "/cashier-shifts", h.cashier, { openingFloatCents: 0 });
});

async function register(givenName: string) {
  return (await api("POST", "/patients", h.nurse, {
    givenName,
    familyName: "Otieno",
    sex: "female",
    dateOfBirth: "1992-03-14",
    noPhoneReason: "no_phone",
    noIdReason: "not_carried",
    confirmNotDuplicate: true,
  })).id as string;
}

/** The queue entry the patient is in now. */
async function entryOf(encounterId: string) {
  return (await api("GET", `/encounters/${encounterId}`, h.nurse)).queue.entryId as string;
}

/** Triage takes the vital signs and sends the patient on to the clinic, which charges its fee. */
async function triaged(encounterId: string) {
  const entry = await entryOf(encounterId);
  await api("POST", `/queue-entries/${entry}/serve`, h.nurse);
  await api("POST", `/encounters/${encounterId}/observations`, h.nurse, {
    readings: [{ code: "temperature", value: 38.4 }, { code: "pulse", value: 96 }, { code: "bp_systolic", value: 118 }, { code: "bp_diastolic", value: 76 }],
  });
  await api("POST", `/queue-entries/${entry}/finish`, h.nurse, { nextServicePointId: gopd, priority: "urgent" });
}

/** The cashier bills what is unbilled and takes it in cash. */
async function paysCash(patientId: string, encounterId: string) {
  const invoice = await api("POST", `/encounters/${encounterId}/bill-now`, h.cashier, undefined, 201);
  await api("POST", "/payments", h.cashier, { patientId, method: "cash", amountCents: invoice.totalCents, invoiceId: invoice.id }, 201);
  return invoice.totalCents as number;
}

/** The lab takes the sample, enters the result, and another lab member verifies it. */
async function resulted(orderId: string, itemId: string, answer: string) {
  const specimen = await api("POST", `/orders/${orderId}/specimens`, labTech, { specimenType: "blood" }, 201);
  const result = await api("POST", `/specimens/${specimen.id}/results`, labTech, { orderItemId: itemId, values: [{ analyteId: mrdt.analyteId, value: answer }] }, 201);
  await api("POST", `/lab-results/${result.id}/verify`, supervisor, {});
}

function paybill(transId: string, reference: string, amountCents: number) {
  return app.request(`/webhooks/mpesa/${token}/c2b/confirmation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      TransID: transId,
      TransTime: darajaTimestamp(new Date()),
      TransAmount: (amountCents / 100).toFixed(2),
      BusinessShortCode: "600123",
      BillRefNumber: reference,
      MSISDN: "254712345678",
    }),
  });
}

describe("a day's outpatients (the P3 exit)", () => {
  it("runs registration to cashier with no charge posted by hand, and reconciles", async () => {
    // --- Amina: pays as she goes, in cash ---
    const amina = await register("Amina");
    const aminaVisit = (await api("POST", "/encounters", h.nurse, { patientId: amina, kind: "opd" }, 201)).id as string;
    await triaged(aminaVisit);
    // She pays the clinic's fee before she is seen.
    expect(await paysCash(amina, aminaVisit)).toBe(50_000);

    let entry = await entryOf(aminaVisit);
    await api("POST", `/queue-entries/${entry}/serve`, doctor);
    await api("POST", `/encounters/${aminaVisit}/notes`, doctor, { kind: "consultation", presentingComplaint: "Fever for three days", plan: "MRDT, then review" }, 201)
      .then(note => api("POST", `/notes/${note.id}/sign`, doctor));
    await api("POST", `/encounters/${aminaVisit}/diagnoses`, doctor, { code: "1F40.Z", certainty: "provisional" }, 201);
    const order = await api("POST", `/encounters/${aminaVisit}/orders`, doctor, { items: [{ labTestId: mrdt.testId }], urgency: "urgent" }, 201);
    await api("POST", `/queue-entries/${entry}/finish`, doctor, {});
    // The test was charged as it was ordered; she pays for it on the way to the lab.
    expect(await paysCash(amina, aminaVisit)).toBe(30_000);

    const worklist = await api("GET", "/lab/worklist", labTech);
    expect(JSON.stringify(worklist)).toContain(order.id);
    await resulted(order.id, order.items[0].id, "Positive");

    // Back to the clinic with her result: no second fee for the same clinic.
    await api("POST", `/encounters/${aminaVisit}/queue`, h.nurse, { servicePointId: gopd }, 201);
    entry = await entryOf(aminaVisit);
    await api("POST", `/queue-entries/${entry}/serve`, doctor);
    const results = await api("GET", `/encounters/${aminaVisit}/lab-results`, doctor);
    expect(results.results).toEqual([expect.objectContaining({ code: "MRDT", status: "verified", values: [expect.objectContaining({ value: "Positive", flag: "abnormal" })] })]);
    expect(results.reports).toHaveLength(1);
    const diagnosis = (await api("GET", `/encounters/${aminaVisit}/diagnoses`, doctor)).diagnoses[0];
    await api("POST", `/diagnoses/${diagnosis.id}/confirm`, doctor);
    const prescription = await api("POST", `/encounters/${aminaVisit}/prescriptions`, doctor, {
      indication: "Malaria",
      items: [{ drugCode: "AL-20/120-TAB", doseAmount: "4", frequency: "bd", durationDays: 3 }],
    }, 201);
    const printed = await call("GET", `/documents/${prescription.prescription.documentId}/pdf`, h.facility.id, doctor);
    expect([printed.status, printed.headers.get("content-type")]).toEqual([200, "application/pdf"]);
    await api("POST", `/queue-entries/${entry}/finish`, doctor, {});

    // --- Baraka: on an appointment, billed at the end, pays by paybill ---
    const baraka = await register("Baraka");
    const appointment = await api("POST", "/appointments", h.nurse, { patientId: baraka, servicePointId: gopd, date: TODAY }, 201);
    const barakaVisit = (await api("POST", `/appointments/${appointment.id}/check-in`, h.nurse, {})).encounterId as string;
    await triaged(barakaVisit);
    entry = await entryOf(barakaVisit);
    await api("POST", `/queue-entries/${entry}/serve`, doctor);
    await api("POST", `/encounters/${barakaVisit}/notes`, doctor, { kind: "consultation", presentingComplaint: "Review of blood pressure", plan: "Continue; review in a month" }, 201)
      .then(note => api("POST", `/notes/${note.id}/sign`, doctor));
    await api("POST", `/queue-entries/${entry}/finish`, doctor, {});
    const draft = await api("POST", `/encounters/${barakaVisit}/invoices`, h.clerk, { kind: "final" }, 201);
    const final = await api("POST", `/invoices/${draft.id}/finalise`, h.clerk);
    expect((await paybill("SKBARAKA01", final.number, final.totalCents)).status).toBe(200);
    expect(await api("GET", `/invoices/${draft.id}`, h.finance)).toMatchObject({ totalCents: 50_000, paidCents: 50_000, balanceCents: 0 });

    // --- Chebet: a walk-in for the lab, sent by an outside doctor ---
    const chebet = await register("Chebet");
    const chebetVisit = (await api("POST", "/encounters", h.nurse, { patientId: chebet, kind: "opd", queueAt: null }, 201)).id as string;
    const walkIn = await api("POST", `/encounters/${chebetVisit}/walk-in-orders`, h.nurse, {
      requester: { name: "Dr. Wanjiru Kamau", facility: "Mji Mpya Clinic" },
      labTestIds: [mrdt.testId],
    }, 201);
    expect(await paysCash(chebet, chebetVisit)).toBe(30_000);
    await resulted(walkIn.id, walkIn.items[0].id, "Negative");

    // --- The end of the day ---
    // Each visit closes itself: nobody queued, every test resulted, nothing owed, the patient seen or tested.
    expect(await closeFinishedVisits()).toMatchObject({ closed: 3, failed: 0 });
    const visits = await db.select({ status: encounters.status }).from(encounters).where(inArray(encounters.id, [aminaVisit, barakaVisit, chebetVisit]));
    expect(visits.map(v => v.status)).toEqual(["closed", "closed", "closed"]);
    expect((await api("GET", "/cashier/due", h.cashier)).visits).toEqual([]);

    // Every charge came from the work that was done: none was posted by hand.
    const raised = await db.select().from(charges).where(eq(charges.facilityId, h.facility.id));
    // Two clinic fees and two tests.
    expect(raised).toHaveLength(4);
    expect(raised.filter(ch => ch.manualReason !== null)).toEqual([]);
    expect(raised.every(ch => (ch.queueEntryId === null) !== (ch.orderItemId === null))).toBe(true);

    // The money reconciles (M7): all charged is billed, all received is applied.
    const { totals, drift } = await runAsFacility(h.facility.id, tx => reconcile(tx));
    expect(drift).toEqual([]);
    expect(totals).toEqual({
      chargedCents: 160_000,
      invoicedCents: 160_000,
      adjustedCents: 0,
      receivedCents: 160_000,
      allocatedCents: 160_000,
      refundedCents: 0,
      creditCents: 0,
      owedCents: 0,
    });

    // Every clinical read named who read it (rule 9).
    const reads = await db.select({ actorId: auditLog.actorId, summary: auditLog.summary }).from(auditLog).where(and(eq(auditLog.facilityId, h.facility.id), eq(auditLog.action, "encounter.viewed"), isNotNull(auditLog.actorId)));
    expect(reads.map(r => r.summary)).toEqual(expect.arrayContaining([expect.stringMatching(/^Viewed lab results/), expect.stringMatching(/^Viewed diagnoses/)]));
    const opened = await db.select().from(auditLog).where(and(eq(auditLog.action, "document.viewed"), eq(auditLog.actorId, doctor.id)));
    expect(opened).toHaveLength(1);
  });
});
