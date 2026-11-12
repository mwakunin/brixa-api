import { eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { Hospital, StaffMember } from "@/test/hospital";

import app from "@/app";
import db, { pool } from "@/db";
import { auditLog, charges, documents } from "@/db/schema";
import { addDays, businessDate } from "@/lib/dates";
import { loadDrugCatalogue } from "@/lib/drug-catalogue-load";
import { addMembership, resetDb, signedInUser } from "@/test/helpers";
import { call, hospital } from "@/test/hospital";

/** P3 slice 4b: prescriptions from the shared drug catalogue, with a printed RX- document. */

const SAMPLE = path.resolve(import.meta.dirname, "../test/fixtures/drug-catalogue-sample.csv");

let h: Hospital;
let doctor: StaffMember;
let nurse: StaffMember;

async function staff(roles: Parameters<typeof addMembership>[2]): Promise<StaffMember> {
  const user = await signedInUser();
  const membership = await addMembership(user.id, h.facility.id, roles);
  return { ...user, actor: { userId: user.id, membershipId: membership.id } };
}

beforeEach(async () => {
  await resetDb();
  await loadDrugCatalogue(await readFile(SAMPLE, "utf8"));
  h = await hospital();
  doctor = await staff(["doctor"]);
  nurse = await staff(["nurse"]);
});

/** An open visit; the hospital's patient is an adult unless `bornOn` is given. */
async function visit(bornOn?: string): Promise<{ encounterId: string; patientId: string }> {
  const patientId = bornOn
    ? (await (await call("POST", "/patients", h.facility.id, h.nurse, {
        givenName: "Amani",
        familyName: "Mwangi",
        sex: "female",
        dateOfBirth: bornOn,
        noPhoneReason: "no_phone",
        noIdReason: "none_held",
        confirmNotDuplicate: true,
      })).json()).id as string
    : await h.patient();
  const encounterId = (await (await call("POST", "/encounters", h.facility.id, h.nurse, { patientId, kind: "opd", queueAt: null })).json()).id as string;
  return { encounterId, patientId };
}

function prescribe(encounterId: string, body: Record<string, unknown>, who: StaffMember = doctor) {
  return call("POST", `/encounters/${encounterId}/prescriptions`, h.facility.id, who, body);
}
const paracetamol = { drugCode: "PCM-500-TAB", doseAmount: "1", frequency: "tds", durationDays: 5 };

async function printed(documentId: string) {
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
  return doc;
}

describe("a prescription", () => {
  it("is written from the catalogue, with its quantity worked out and its RX- document issued, not charged", async () => {
    const { encounterId } = await visit();

    const res = await prescribe(encounterId, {
      indication: "Malaria",
      items: [
        { ...paracetamol, doseAmount: "0.5", instructions: "After meals" },
        { drugCode: "al-20/120-tab", doseAmount: "4", frequency: "bd", durationDays: 3 },
        { drugCode: "IBU-400-TAB", doseAmount: "1", frequency: "prn", quantity: "10" },
      ],
    });

    expect(res.status).toBe(201);
    const order = await res.json();
    expect(order).toMatchObject({ orderedBy: { membershipId: doctor.actor.membershipId }, indication: "Malaria", prescription: { number: `RX-${businessDate().slice(0, 4)}-000001`, voided: false } });
    expect(order.items.map((i: { code: string; medication: { quantity: string; route: string } }) => [i.code, i.medication.quantity, i.medication.route])).toEqual([
      ["AL-20/120-TAB", "24.000", "oral"],
      ["IBU-400-TAB", "10.000", "oral"],
      ["PCM-500-TAB", "7.500", "oral"],
    ]);
    expect(order.items[2]).toMatchObject({ kind: "medication", name: "Paracetamol 500 mg Tablet", billableItemId: null, amountCents: null });
    expect(await db.select().from(charges)).toEqual([]);

    const doc = await printed(order.prescription.documentId);
    expect(doc.kind).toBe("prescription");
    expect(doc.content.fields).toEqual(expect.arrayContaining([
      { label: "Allergies", value: "Not recorded" },
      { label: "For", value: "Malaria" },
      { label: "Prescriber", value: expect.stringMatching(/, KMPDC licence TEST-0001$/) },
    ]));
    expect(doc.content.table!.rows[0]).toEqual(["Paracetamol 500 mg Tablet", "0.5 tablet", "Oral", "Three times daily (TDS)", "5", "7.5 tablet", "After meals"]);
    const pdf = await call("GET", `/documents/${doc.id}/pdf`, h.facility.id, nurse);
    expect([pdf.status, pdf.headers.get("content-type")]).toEqual([200, "application/pdf"]);
    expect((await call("GET", `/documents/${doc.id}/pdf`, h.facility.id, h.cashier)).status).toBe(403);
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "prescription.issued"));
    expect(entry.detail).toMatchObject({ drugs: ["PCM-500-TAB", "AL-20/120-TAB", "IBU-400-TAB"], controlled: [] });
  });

  it("takes only what fits each frequency", async () => {
    const { encounterId } = await visit();
    const status = async (item: Record<string, unknown>) => (await prescribe(encounterId, { items: [item] })).status;

    expect(await status({ ...paracetamol, durationDays: undefined })).toBe(422);
    expect(await status({ ...paracetamol, frequency: "stat" })).toBe(422);
    // A single dose supplies the dose itself.
    expect(await status({ drugCode: "PCM-500-TAB", doseAmount: "2", frequency: "stat", quantity: "1" })).toBe(422);
    expect(await status({ ...paracetamol, frequency: "prn" })).toBe(422);
    expect(await status({ ...paracetamol, doseAmount: "0" })).toBe(422);
    expect(await status({ ...paracetamol, dose: "1" })).toBe(422);
    expect(await status({ drugCode: "MOR-10-INJ", doseAmount: "0.5", frequency: "stat" })).toBe(201);
    expect((await (await prescribe(encounterId, { items: [paracetamol, paracetamol] })).json()).code).toBe("duplicate_drug");
    const issue = async (items: Record<string, unknown>[]) => {
      const res = await prescribe(encounterId, { items });
      return [res.status, (await res.json()).error?.issues[0].path];
    };
    expect(await issue([paracetamol, { ...paracetamol, drugCode: "NOPE" }])).toEqual([422, ["items", 1, "drugCode"]]);
    // A tablet is never injected; an injection may be given by another injected route.
    expect(await issue([{ ...paracetamol, route: "iv" }])).toEqual([422, ["items", 0, "route"]]);
    expect(await status({ drugCode: "MOR-10-INJ", doseAmount: "0.5", frequency: "stat", route: "iv" })).toBe(201);
    expect(await status({ ...paracetamol, route: "rectal" })).toBe(201);
    // More than a prescription holds, worked out from the dose and days.
    expect(await issue([{ ...paracetamol, doseAmount: "100000", frequency: "qid", durationDays: 365 }])).toEqual([422, ["items", 0, "quantity"]]);
    // A misspelt field is refused, not left off the paper.
    expect((await prescribe(encounterId, { items: [paracetamol], indicaton: "Fever" })).status).toBe(422);
  });

  it("is refused for a drug the patient is allergic to, by generic name or ingredient, unless a reason is given", async () => {
    const { encounterId, patientId } = await visit();
    await call("POST", `/patients/${patientId}/allergies`, h.facility.id, doctor, { category: "drug", allergen: "Amoxicillin", drugCode: "AMX-500-CAP", reaction: "Rash", severity: "severe" });
    const coAmoxiclav = { drugCode: "AMC-625-TAB", doseAmount: "1", frequency: "bd", durationDays: 7 };

    const refused = await prescribe(encounterId, { items: [coAmoxiclav] });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      code: "drug_allergy",
      message: expect.stringContaining("Amoxicillin (Rash)"),
      allergies: [{ drugCode: "AMC-625-TAB", allergen: "Amoxicillin", reaction: "Rash", severity: "severe" }],
    });

    const res = await prescribe(encounterId, { items: [{ ...coAmoxiclav, allergyOverride: "Rash was mild and remote; benefits outweigh" }] });
    expect(res.status).toBe(201);
    const order = await res.json();
    expect(order.items[0].medication.allergyOverrideReason).toBe("Rash was mild and remote; benefits outweigh");
    const doc = await printed(order.prescription.documentId);
    expect(doc.content.fields).toContainEqual({ label: "Allergies", value: "Amoxicillin (Rash)" });
    expect(doc.content.notes).toEqual(["Amoxicillin/Clavulanic acid prescribed despite a recorded allergy to Amoxicillin: Rash was mild and remote; benefits outweigh"]);
    const [override] = await db.select().from(auditLog).where(eq(auditLog.action, "prescription.allergy_overridden"));
    expect(override.detail).toMatchObject({ drugCode: "AMC-625-TAB", allergens: ["Amoxicillin"] });

    // An allergy recorded as text alone is matched where it names the drug, strength and all.
    const third = await visit();
    await call("POST", `/patients/${third.patientId}/allergies`, h.facility.id, doctor, { category: "drug", allergen: "Amoxicillin 500 mg caps" });
    expect((await (await prescribe(third.encounterId, { items: [coAmoxiclav] })).json()).code).toBe("drug_allergy");

    // An allergy recorded as text alone, before drugs could be named, is matched by name.
    const other = await visit();
    await call("POST", `/patients/${other.patientId}/allergies`, h.facility.id, doctor, { category: "drug", allergen: "ibuprofen" });
    expect((await (await prescribe(other.encounterId, { items: [{ drugCode: "IBU-400-TAB", doseAmount: "1", frequency: "prn", quantity: "6" }] })).json()).code).toBe("drug_allergy");
  });

  it("says so when the allergy list is too long to print in full", async () => {
    const { encounterId, patientId } = await visit();
    for (let i = 1; i <= 12; i += 1)
      await call("POST", `/patients/${patientId}/allergies`, h.facility.id, doctor, { category: "food", allergen: `Food allergen number ${i} with a long name`, reaction: "Hives and swelling" });

    const order = await (await prescribe(encounterId, { items: [paracetamol] })).json();

    const doc = await printed(order.prescription.documentId);
    const allergies = doc.content.fields.find(f => f.label === "Allergies")!.value;
    expect(allergies.length).toBeLessThanOrEqual(500);
    expect(allergies).toMatch(/and \d+ more: check the patient's allergy record$/);
  });

  it("prints every allergy override, however many, within the notes a document holds", async () => {
    const { encounterId, patientId } = await visit();
    const drugs = ["PCM-500-TAB", "PCM-120-SUSP", "AMX-500-CAP", "AMX-125-SUSP", "AMC-625-TAB", "AL-20/120-TAB", "CRO-1G-INJ", "IBU-400-TAB", "ORS-SACH", "MOR-10-INJ"];
    for (const name of ["Paracetamol", "Amoxicillin", "Artemether", "Ceftriaxone", "Ibuprofen", "Oral rehydration salts, low osmolarity", "Morphine", "Lumefantrine", "Clavulanic acid"])
      await call("POST", `/patients/${patientId}/allergies`, h.facility.id, doctor, { category: "drug", allergen: name });

    const res = await prescribe(encounterId, {
      items: drugs.map(drugCode => ({ drugCode, doseAmount: "1", frequency: "stat", allergyOverride: `Benefits outweigh the risk for ${drugCode}, discussed with the patient` })),
    });

    expect(res.status).toBe(201);
    const doc = await printed((await res.json()).prescription.documentId);
    expect(doc.content.notes.length).toBeLessThanOrEqual(10);
    expect(doc.content.notes.join(" ")).toContain("Benefits outweigh the risk for MOR-10-INJ");
  });

  it("for a child under 12 needs a weight taken today, and prints it", async () => {
    const { encounterId } = await visit(addDays(businessDate(), -4 * 365));
    const syrup = { drugCode: "PCM-120-SUSP", doseAmount: "7.5", frequency: "qid", durationDays: 3 };

    expect((await (await prescribe(encounterId, { items: [syrup] })).json()).code).toBe("weight_needed");
    await call("POST", `/encounters/${encounterId}/observations`, h.facility.id, nurse, { readings: [{ code: "weight", value: 15.2 }] });
    const res = await prescribe(encounterId, { items: [syrup] });

    expect(res.status).toBe(201);
    const doc = await printed((await res.json()).prescription.documentId);
    expect(doc.content.fields).toEqual(expect.arrayContaining([
      { label: "Sex and age", value: "Female, 3 years" },
      { label: "Weight", value: `15.2 kg, taken ${doc.content.fields.find(f => f.label === "Date")!.value}` },
    ]));
  });

  it("is written by doctors, clinical officers and nurses, a controlled drug by doctors and clinical officers only", async () => {
    const { encounterId } = await visit();
    const morphine = { drugCode: "MOR-10-INJ", doseAmount: "0.5", frequency: "stat" };

    expect((await prescribe(encounterId, { items: [paracetamol] }, nurse)).status).toBe(201);
    expect((await prescribe(encounterId, { items: [paracetamol] }, await staff(["pharmacist"]))).status).toBe(403);
    const refused = await prescribe(encounterId, { items: [morphine] }, nurse);
    expect([refused.status, (await refused.json()).code]).toEqual([403, "controlled_prescriber"]);
    const res = await prescribe(encounterId, { items: [morphine] }, await staff(["clinical_officer"]));
    expect(res.status).toBe(201);
    const doc = await printed((await res.json()).prescription.documentId);
    expect(doc.content.table!.rows[0][0]).toBe("Morphine 10 mg/mL Injection (controlled, Schedule II)");
  });

  it("is changed by cancelling it, which voids its paper, never by cancelling a medicine on its own", async () => {
    const { encounterId } = await visit();
    const order = await (await prescribe(encounterId, { items: [paracetamol] })).json();
    const cancelVisit = () => call("POST", `/encounters/${encounterId}/cancel`, h.facility.id, h.nurse, { reason: "Wrong patient" });

    expect((await (await call("POST", `/order-items/${order.items[0].id}/cancel`, h.facility.id, doctor, { reason: "Wrong dose" })).json()).code).toBe("cancel_the_prescription");
    expect((await (await call("POST", `/order-items/${order.items[0].id}/done`, h.facility.id, doctor)).json()).code).toBe("not_a_service_item");
    expect((await (await cancelVisit()).json()).code).toBe("has_clinical_records");

    const res = await call("POST", `/prescriptions/${order.id}/cancel`, h.facility.id, doctor, { reason: "Wrong patient" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ prescription: { voided: true }, items: [{ status: "cancelled", cancellationReason: "Wrong patient" }] });
    expect((await (await call("POST", `/prescriptions/${order.id}/cancel`, h.facility.id, doctor, { reason: "Again" })).json()).code).toBe("already_cancelled");
    expect((await call("POST", `/prescriptions/${order.id}/cancel`, h.facility.id, h.clerk, { reason: "x" })).status).toBe(403);

    const [doc] = await db.select().from(documents).where(eq(documents.id, order.prescription.documentId));
    const verified = await (await app.request(`/verify/${doc.verificationCode}`)).json();
    expect(verified).toMatchObject({ number: order.prescription.number, status: "withdrawn" });
    expect((await cancelVisit()).status).toBe(200);
  });
});

describe("the drug catalogue", () => {
  it("is searched by clinical staff by generic name or code, current drugs only", async () => {
    const search = async (q: string, who: StaffMember = nurse) => (await (await call("GET", `/drugs?q=${encodeURIComponent(q)}`, h.facility.id, who)).json()).drugs?.map((d: { code: string }) => d.code);

    expect(await search("amox")).toEqual(["AMX-125-SUSP", "AMX-500-CAP", "AMC-625-TAB"]);
    expect(await search("clav")).toEqual(["AMC-625-TAB"]);
    expect(await search("pcm-1")).toEqual(["PCM-120-SUSP"]);
    expect(await search("oral rehydration")).toEqual(["ORS-SACH"]);
    // An underscore typed is an underscore, not any one character.
    expect(await search("PCM_")).toEqual([]);
    // A drug named for what was typed comes before a combination that only contains it.
    expect(await search("clav")).toEqual(["AMC-625-TAB"]);
    expect(await search("lumefantrine")).toEqual(["AL-20/120-TAB"]);
    await pool.query("INSERT INTO drug_catalogue (code, generic_name, strength, form, dose_unit, route, loaded_at) VALUES ('AAA-1', 'Aaa/Paracetamol', '1 mg', 'Tablet', 'tablet', 'oral', now())");
    expect(await search("paracetamol")).toEqual(["PCM-120-SUSP", "PCM-500-TAB", "AAA-1"]);
    expect((await call("GET", "/drugs?q=amox", h.facility.id, h.cashier)).status).toBe(403);

    const reloaded = (await readFile(SAMPLE, "utf8")).split("\n").filter(l => !l.startsWith("IBU-")).join("\n");
    // Ibuprofen, and the made-up combination above, are not in it.
    expect(await loadDrugCatalogue(reloaded)).toEqual({ loaded: 9, retired: 2 });
    expect(await search("ibuprofen")).toEqual([]);
  });

  it("names the drug a drug allergy is to, and only a drug allergy", async () => {
    const { patientId } = await visit();
    const record = (body: Record<string, unknown>) => call("POST", `/patients/${patientId}/allergies`, h.facility.id, doctor, body);

    expect((await record({ category: "food", allergen: "Peanuts", drugCode: "AMX-500-CAP" })).status).toBe(422);
    const unknown = await record({ category: "drug", allergen: "X", drugCode: "NOPE" });
    expect([unknown.status, (await unknown.json()).error.issues[0].path]).toEqual([422, ["drugCode"]]);
    // A misspelt code is refused, not dropped from an allergy prescribing then cannot check.
    expect((await record({ category: "drug", allergen: "Amoxil", drugCod: "AMX-500-CAP" })).status).toBe(422);
    expect(await (await record({ category: "drug", allergen: "Amoxicillin", drugCode: "amx-500-cap" })).json()).toMatchObject({ drugCode: "AMX-500-CAP" });
    const { rows } = await pool.query("SELECT drug_code FROM patient_allergies WHERE patient_id = $1", [patientId]);
    expect(rows).toEqual([{ drug_code: "AMX-500-CAP" }]);
  });
});

describe("the database's prescription guards", () => {
  it("freeze a medicine as prescribed, for every role", async () => {
    const { encounterId } = await visit();
    const order = await (await prescribe(encounterId, { items: [paracetamol] })).json();
    const refusal = (query: string) => pool.query(query, [order.items[0].id]).then(() => "accepted", (err: { message: string }) => err.message);

    expect(await refusal("UPDATE order_items SET quantity = 100 WHERE id = $1")).toMatch(/never changes/);
    expect(await refusal("UPDATE order_items SET drug_description = 'Other' WHERE id = $1")).toMatch(/never changes/);
    expect(await refusal("DELETE FROM order_items WHERE id = $1")).toMatch(/never deleted/);
    // Nor does an issued prescription take a medicine its printed paper does not list.
    const added = await pool.query(
      `INSERT INTO order_items (facility_id, order_id, status, drug_code, drug_description, dose_amount, dose_unit, route, frequency, quantity)
       SELECT facility_id, order_id, 'ordered', 'IBU-400-TAB', 'Ibuprofen 400 mg Tablet', 1, 'tablet', 'oral', 'stat', 1 FROM order_items WHERE id = $1`,
      [order.items[0].id],
    ).then(() => "accepted", (err: { message: string }) => err.message);
    expect(added).toMatch(/issued prescription/);
  });

  it("hold a medicine to its shape", async () => {
    const { encounterId } = await visit();
    // An order with no paper of its own, so the shape is what refuses.
    const { rows: [order] } = await pool.query(
      "INSERT INTO orders (facility_id, encounter_id, urgency, ordered_by, entered_by, ordered_at) VALUES ($1, $2, 'routine', $3, $3, now()) RETURNING id",
      [h.facility.id, encounterId, doctor.actor.membershipId],
    );
    const insert = (columns: string, values: string) => pool.query(
      `INSERT INTO order_items (facility_id, order_id, status, drug_code, drug_description, dose_amount, dose_unit, route, quantity${columns})
       VALUES ($1, $2, 'ordered', 'AMX-500-CAP', 'Amoxicillin 500 mg Capsule', 1, 'capsule', 'oral', 15${values})`,
      [h.facility.id, order.id],
    ).then(() => "accepted", (err: { message: string }) => err.message);

    expect(await insert(", frequency", ", 'tds'")).toMatch(/order_items_medication_shape/);
    expect(await insert(", frequency, duration_days", ", 'stat', 5")).toMatch(/order_items_medication_shape/);
    expect(await insert("", "")).toMatch(/order_items_medication_shape/);
    expect(await insert(", frequency, duration_days", ", 'tds', 5")).toBe("accepted");
  });
});
