import { and, desc, eq, sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { Hospital, StaffMember } from "@/test/hospital";

import db from "@/db";
import { auditLog, controlledDrugRegister } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import { addDays, businessDate } from "@/lib/dates";
import { pgErrorCode } from "@/lib/db-errors";
import { loadDrugCatalogue } from "@/lib/drug-catalogue-load";
import { reconcile } from "@/lib/reconciliation";
import { addMembership, resetDb, signedInUser } from "@/test/helpers";
import { call, hospital, TODAY } from "@/test/hospital";

/** P4 slice 4: the controlled-drug register, written by the ledger itself. */

const SAMPLE = path.resolve(import.meta.dirname, "../test/fixtures/drug-catalogue-sample.csv");

let h: Hospital;
let doctor: StaffMember;
let pharmacist: StaffMember;
let storekeeper: StaffMember;
let main: string;
let pharmacy: string;
/** Morphine 10 mg/mL, schedule II, counted in mL. */
let morphine: string;

const inDays = (days: number) => addDays(businessDate(), days);

async function staff(roles: Parameters<typeof addMembership>[2], licence?: string): Promise<StaffMember> {
  const user = await signedInUser();
  const membership = await addMembership(user.id, h.facility.id, roles, licence ? { licence: { number: licence, expiresOn: inDays(365) } } : {});
  return { ...user, actor: { userId: user.id, membershipId: membership.id } };
}

async function created(res: Response) {
  expect(res.status).toBe(201);
  return res.json();
}

const post = (url: string, who: StaffMember, body: unknown = {}) => call("POST", url, h.facility.id, who, body);

async function stockItem(code: string, drugCode: string, baseUnit: string): Promise<string> {
  const item = (await created(await post("/billable-items", h.admin, { code, name: code, category: "drug" }))).id;
  const change = await (await post("/price-changes", h.admin, { effectiveFrom: TODAY, reason: "Tariff", lines: [{ billableItemId: item, unitPriceCents: 10_000 }] })).json();
  await post(`/price-changes/${change.id}/approve`, h.finance);
  return (await created(await post("/stock-items", h.admin, { billableItemId: item, drugCode, baseUnit, packSize: 1 }))).id;
}

async function receive(storeId: string, stockItemId: string, batchNumber: string, units: number) {
  return created(await post("/goods-received", storekeeper, { storeId, supplier: "KEMSA", lines: [{ stockItemId, batchNumber, expiresOn: inDays(300), units, totalCostCents: units * 100 }] }));
}

async function page(storeId: string, drugCode = "MOR-10-INJ") {
  return db.select().from(controlledDrugRegister).where(sql`${controlledDrugRegister.storeId} = ${storeId} AND ${controlledDrugRegister.drugCode} = ${drugCode}`).orderBy(controlledDrugRegister.entry);
}

beforeEach(async () => {
  await resetDb();
  await loadDrugCatalogue(await readFile(SAMPLE, "utf8"));
  h = await hospital();
  doctor = await staff(["doctor"], "KMPDC-111");
  pharmacist = await staff(["pharmacist"], "PPB-222");
  storekeeper = await staff(["storekeeper"]);
  main = (await created(await post("/stores", h.admin, { name: "Main store", kind: "main" }))).id;
  pharmacy = (await created(await post("/stores", h.admin, { name: "Pharmacy", kind: "pharmacy" }))).id;
  morphine = await stockItem("MOR-10", "MOR-10-INJ", "mL");
});

/** A patient given 2 mL of morphine at the pharmacy; answers the dispense line. */
async function dispensed(): Promise<{ lineId: string; patientId: string }> {
  const patientId = await h.patient();
  const visit = await created(await post("/encounters", h.nurse, { patientId, kind: "opd" }));
  const order = await created(await post(`/encounters/${visit.id}/prescriptions`, doctor, { items: [{ drugCode: "MOR-10-INJ", doseAmount: "2", frequency: "stat" }] }));
  const dispense = await created(await post("/dispenses", pharmacist, { orderId: order.id, storeId: pharmacy, lines: [{ orderItemId: order.items[0].id, stockItemId: morphine }] }));
  await post(`/dispenses/${dispense.id}/hand-over`, pharmacist);
  return { lineId: dispense.lines[0].id, patientId };
}

describe("the controlled-drug register", () => {
  it("records every movement of a controlled drug, per store, with its running balance and who moved it", async () => {
    await receive(main, morphine, "M1", 50);
    const sent = await created(await post("/stock-transfers/send", storekeeper, { fromStoreId: main, toStoreId: pharmacy, lines: [{ stockItemId: morphine, quantity: 20 }] }));
    await post(`/stock-transfers/${sent.id}/receive`, pharmacist);
    const { lineId, patientId } = await dispensed();
    await created(await post(`/dispense-lines/${lineId}/returns`, pharmacist, { quantity: 1, reason: "One ampoule unopened", fitForResale: true }));

    expect((await page(main)).map(l => [l.kind, l.quantity, l.balance])).toEqual([["receipt", 50, 50], ["transfer_out", -20, 30]]);
    const shelf = await page(pharmacy);
    expect(shelf.map(l => [l.kind, l.quantity, l.balance])).toEqual([["transfer_in", 20, 20], ["dispense", -2, 18], ["dispense_returned", 1, 19]]);
    // The patient, and both prescriber and dispenser with the licence they held then.
    expect(shelf[1]).toMatchObject({ patientId, prescribedBy: doctor.actor.membershipId, prescriberLicence: "KMPDC-111", recordedBy: pharmacist.actor.membershipId, recorderLicence: "PPB-222" });
  });

  it("writes nothing for a drug that is not controlled", async () => {
    const paracetamol = await stockItem("PCM-B", "PCM-500-TAB", "tablet");

    await receive(main, paracetamol, "P1", 100);

    expect(await db.select().from(controlledDrugRegister)).toEqual([]);
  });

  it("keeps one page per drug and store, whatever brand or batch moves, a line at a time", async () => {
    const otherBrand = await stockItem("MOR-10-B", "MOR-10-INJ", "mL");
    await receive(pharmacy, morphine, "M1", 3);
    await receive(pharmacy, morphine, "M2", 5);
    await receive(pharmacy, otherBrand, "B1", 4);
    const visit = await created(await post("/encounters", h.nurse, { patientId: await h.patient(), kind: "opd" }));
    const order = await created(await post(`/encounters/${visit.id}/prescriptions`, doctor, { items: [{ drugCode: "MOR-10-INJ", doseAmount: "6", frequency: "stat" }] }));

    // Six from two batches, written in one statement: each line follows the one before.
    await created(await post("/dispenses", pharmacist, { orderId: order.id, storeId: pharmacy, lines: [{ orderItemId: order.items[0].id, stockItemId: morphine }] }));

    expect((await page(pharmacy)).map(l => [l.kind, l.quantity, l.balance])).toEqual([
      ["receipt", 3, 3],
      ["receipt", 5, 8],
      ["receipt", 4, 12],
      ["dispense", -3, 9],
      ["dispense", -3, 6],
    ]);
  });

  it("brings stock held before a drug was scheduled into the register as the catalogue schedules it, and keeps its page if unscheduled", async () => {
    const ibuprofen = await stockItem("IBU-400", "IBU-400-TAB", "tablet");
    await receive(pharmacy, ibuprofen, "I1", 40);
    expect(await page(pharmacy, "IBU-400-TAB")).toEqual([]);
    const catalogue = await readFile(SAMPLE, "utf8");

    // A later catalogue load schedules it: the stock held is brought forward then, under a lock on the ledger.
    await loadDrugCatalogue(catalogue.replace("IBU-400-TAB,Ibuprofen,400 mg,Tablet,tablet,oral,", "IBU-400-TAB,Ibuprofen,400 mg,Tablet,tablet,oral,IV"));
    await receive(pharmacy, ibuprofen, "I2", 10);
    expect((await page(pharmacy, "IBU-400-TAB")).map(l => [l.kind, l.quantity, l.balance])).toEqual([["brought_forward", 40, 40], ["receipt", 10, 50]]);

    // Unscheduled again, its page keeps every movement, so the register never falls behind the ledger.
    await loadDrugCatalogue(catalogue);
    await receive(pharmacy, ibuprofen, "I3", 5);
    expect((await page(pharmacy, "IBU-400-TAB")).map(l => l.balance)).toEqual([40, 50, 55]);
    expect((await runAsFacility(h.facility.id, tx => reconcile(tx))).drift.filter(d => d.identity === "controlled_register")).toEqual([]);
  });

  it("is written by the ledger alone: a request cannot write it, and nobody changes it", async () => {
    await receive(main, morphine, "M1", 50);
    const [line] = await page(main);

    const asApp = await runAsFacility(h.facility.id, tx => tx.execute(sql`INSERT INTO controlled_drug_register (facility_id, store_id, drug_code, kind, quantity, balance) VALUES (${h.facility.id}, ${main}, 'MOR-10-INJ', 'brought_forward', 5, 55)`))
      .then(() => null, (e: unknown) => e);
    expect(pgErrorCode(asApp)).toBe("42501");
    const asOwner = await db.execute(sql`UPDATE controlled_drug_register SET balance = 0 WHERE id = ${line.id}`).then(() => null, (e: unknown) => e);
    expect(pgErrorCode(asOwner)).toBe("23001");
  });

  it("balances against the ledger in the daily check", async () => {
    await receive(main, morphine, "M1", 50);
    expect((await runAsFacility(h.facility.id, tx => reconcile(tx))).drift.filter(d => d.identity === "controlled_register")).toEqual([]);

    // A line written behind the ledger's back, as only the owner could.
    await db.insert(controlledDrugRegister).values({ facilityId: h.facility.id, storeId: main, drugCode: "MOR-10-INJ", kind: "brought_forward", quantity: 5, balance: 55 });

    const { drift } = await runAsFacility(h.facility.id, tx => reconcile(tx));
    expect(drift.filter(d => d.identity === "controlled_register")).toEqual([expect.objectContaining({ detail: "controlled_register: 50 against 55" })]);
  });

  it("finds a scheduled drug held in a store with no page there", async () => {
    const ibuprofen = await stockItem("IBU-400", "IBU-400-TAB", "tablet");
    await receive(pharmacy, ibuprofen, "I1", 40);

    // Scheduled behind the catalogue load's back, so nothing was brought forward.
    await db.execute(sql`UPDATE drug_catalogue SET controlled_schedule = 'IV' WHERE code = 'IBU-400-TAB'`);

    const { drift } = await runAsFacility(h.facility.id, tx => reconcile(tx));
    expect(drift.filter(d => d.identity === "controlled_register")).toEqual([{ identity: "controlled_register", subjectId: ibuprofen, detail: "controlled_register: 40 against 0" }]);
  });

  it("is read by the pharmacist, the facility admin and the auditor, audited with the patients it names", async () => {
    await receive(pharmacy, morphine, "M1", 50);
    const { patientId } = await dispensed();
    const read = (who: StaffMember, query = `drugCode=mor-10-inj&storeId=${pharmacy}`) => call("GET", `/controlled-register?${query}`, h.facility.id, who);

    const res = await read(pharmacist);
    expect(res.status).toBe(200);
    const shown = await res.json();
    expect(shown).toMatchObject({ drug: { code: "MOR-10-INJ", controlledSchedule: "II" }, store: { name: "Pharmacy" }, balanceBefore: 0 });
    expect(shown.lines).toEqual([
      expect.objectContaining({ kind: "receipt", quantityIn: 50, quantityOut: 0, balance: 50, patient: null }),
      expect.objectContaining({ kind: "dispense", quantityIn: 0, quantityOut: 2, balance: 48, patient: expect.objectContaining({ id: patientId }), prescriber: { name: "Test User", licence: "KMPDC-111" } }),
    ]);
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "controlled_register.viewed"));
    expect(entry).toMatchObject({ actorId: pharmacist.id, entityId: pharmacy, detail: { drugCode: "MOR-10-INJ", patients: [patientId] } });

    for (const who of [h.admin, h.auditor])
      expect((await read(who)).status).toBe(200);
    expect((await read(await staff(["pharm_tech"], "PPB-333"))).status).toBe(403);
    // Days after the last line show nothing, with the balance carried.
    const later = await (await read(pharmacist, `drugCode=MOR-10-INJ&storeId=${pharmacy}&from=${inDays(1)}`)).json();
    expect([later.balanceBefore, later.lines]).toEqual([48, []]);
    // The next page carries on from the line before it.
    const next = await (await read(pharmacist, `drugCode=MOR-10-INJ&storeId=${pharmacy}&offset=1`)).json();
    expect([next.balanceBefore, next.lines.map((l: { balance: number }) => l.balance)]).toEqual([50, [48]]);
    // A drug or store that is not there answers as nothing.
    expect((await read(pharmacist, `drugCode=NOPE-1&storeId=${pharmacy}`)).status).toBe(404);
  });

  it("hides the patient on a sensitive medicine's lines outside the pharmacy, unless given its category or through the glass", async () => {
    await receive(pharmacy, morphine, "M1", 50);
    const { patientId } = await dispensed();
    expect((await call("PUT", "/sensitive-drugs", h.facility.id, h.admin, { drugCode: "MOR-10-INJ", category: "mental_health" })).status).toBe(200);
    const dispenseLine = async (who: StaffMember) => (await (await call("GET", `/controlled-register?drugCode=MOR-10-INJ&storeId=${pharmacy}`, h.facility.id, who)).json()).lines[1];
    const audited = async (who: StaffMember) => (await db.select().from(auditLog).where(and(eq(auditLog.action, "controlled_register.viewed"), eq(auditLog.actorId, who.id))).orderBy(desc(auditLog.at)).limit(1))[0].detail;
    const named = expect.objectContaining({ id: patientId });

    expect(await dispenseLine(pharmacist)).toMatchObject({ patient: named, patientHidden: false });
    // The auditor sees the line, its balance and who prescribed it, never whose it was.
    expect(await dispenseLine(h.auditor)).toMatchObject({ kind: "dispense", quantityOut: 2, balance: 48, patient: null, patientHidden: true, prescriber: { licence: "KMPDC-111" } });
    expect(await audited(h.auditor)).toMatchObject({ patients: [], hidden: 1 });

    expect((await call("PUT", `/staff/members/${h.auditor.actor.membershipId}/sensitive-access`, h.facility.id, h.admin, { categories: ["mental_health"] })).status).toBe(200);
    expect(await dispenseLine(h.auditor)).toMatchObject({ patient: named, patientHidden: false });

    // An admin who is also a doctor sees the patient only after breaking the glass, and the dispenser is told.
    const medicalAdmin = await staff(["facility_admin", "doctor"], "KMPDC-444");
    expect((await dispenseLine(medicalAdmin)).patientHidden).toBe(true);
    const grant = await created(await post(`/patients/${patientId}/break-glass`, medicalAdmin, { reason: "A missing ampoule" }));
    expect(await dispenseLine(medicalAdmin)).toMatchObject({ patient: named });
    expect(await audited(medicalAdmin)).toMatchObject({ patients: [patientId], viaGrants: [grant.id] });
  });
});
