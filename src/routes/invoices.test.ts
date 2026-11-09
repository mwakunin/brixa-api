import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { Hospital, Person } from "@/test/hospital";

import db from "@/db";
import { auditLog, documents, invoices } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import { admitPatient, dischargePatient } from "@/lib/encounters";
import { resetDb } from "@/test/helpers";
import { at, call, hospital, TODAY } from "@/test/hospital";

/** The Kenyan year now: read when used, since TODAY is re-read for each test. */
const year = () => TODAY.slice(0, 4);

describe("invoices", () => {
  let h: Hospital;
  let encounterId: string;

  beforeEach(async () => {
    await resetDb();
    h = await hospital();
    encounterId = await visit();
  });

  async function visit() {
    return (await (await call("POST", "/encounters", h.facility.id, h.nurse, { patientId: await h.patient(), kind: "opd" })).json()).id as string;
  }

  async function charge(item: keyof Hospital["items"], quantity = "1", encounter = encounterId) {
    const res = await call("POST", `/encounters/${encounter}/charges`, h.facility.id, h.clerk, { billableItemId: h.items[item], quantity, reason: "Before P3" });
    return (await res.json()).id as string;
  }

  const draft = (kind: string, encounter = encounterId, as: Person = h.cashier) =>
    call("POST", `/encounters/${encounter}/invoices`, h.facility.id, as, { kind });
  const finalise = (id: string, as: Person = h.cashier) => call("POST", `/invoices/${id}/finalise`, h.facility.id, as);
  const voidIt = (id: string, as: Person = h.cashier) => call("POST", `/invoices/${id}/void`, h.facility.id, as, { reason: "Wrong bill" });

  async function refusal(res: Response) {
    return [res.status, (await res.json()).code];
  }

  it("draft every standing charge with no number, and number it at finalisation", async () => {
    await charge("consultation");
    await charge("tablet", "3");

    const drafted = await draft("final");
    expect(drafted.status).toBe(201);
    const body = await drafted.json();
    expect(body).toMatchObject({ kind: "final", status: "draft", number: null, accountKind: "patient", totalCents: 50_800, balanceCents: null });
    expect(body.lines.map((l: { code: string; amountCents: number }) => [l.code, l.amountCents])).toEqual([["CONS", 50_000], ["PCM-500", 800]]);

    const finalised = await finalise(body.id);
    expect(finalised.status).toBe(200);
    expect(await finalised.json()).toMatchObject({ status: "finalised", number: `INV-${year()}-000001`, totalCents: 50_800, balanceCents: 50_800 });
  });

  it("print what was billed, frozen in the document", async () => {
    await charge("tablet", "3");
    const { id } = await (await draft("final")).json();
    await finalise(id);

    const [invoice] = await db.select().from(invoices).where(eq(invoices.id, id));
    const [document] = await db.select().from(documents).where(eq(documents.id, invoice.documentId!));
    expect(document).toMatchObject({ kind: "invoice", number: `INV-${year()}-000001` });
    expect(document.content).toMatchObject({
      title: "Invoice",
      fields: expect.arrayContaining([{ label: "Bill to", value: "Test Patient" }, { label: "Patient number", value: "OP0001" }]),
      table: { rows: [[expect.any(String), "PCM-500", "PCM-500", "3", "KES 2.50", "KES 8.00"]] },
      totals: [{ label: "Total", value: "KES 8.00" }],
    });
  });

  it("number only what is finalised, so a discarded draft leaves no gap", async () => {
    await charge("consultation");
    const other = await visit();
    await charge("consultation", "1", other);

    const discarded = await (await draft("final")).json();
    expect((await voidIt(discarded.id)).status).toBe(200);
    const first = await (await draft("final", other)).json();
    const second = await (await draft("final")).json();

    expect((await (await finalise(first.id)).json()).number).toBe(`INV-${year()}-000001`);
    expect((await (await finalise(second.id)).json()).number).toBe(`INV-${year()}-000002`);
  });

  it("finalise a final invoice only once every charge is billed", async () => {
    await charge("consultation");
    const { id } = await (await draft("final")).json();
    await charge("tablet", "2");

    expect(await refusal(await finalise(id))).toEqual([409, "charges_unbilled"]);

    await voidIt(id);
    const again = await (await draft("final")).json();
    expect(again.totalCents).toBe(50_500);
    expect((await finalise(again.id)).status).toBe(200);
  });

  it("allow one live final invoice per account, and bill later charges on a supplementary one", async () => {
    await charge("consultation");
    const final = await (await draft("final")).json();

    expect(await refusal(await draft("final"))).toEqual([409, "final_exists"]);
    expect(await refusal(await draft("supplementary"))).toEqual([409, "no_final"]);

    await finalise(final.id);
    expect(await refusal(await draft("supplementary"))).toEqual([409, "nothing_to_bill"]);

    await charge("tablet", "4");
    const supplementary = await draft("supplementary");
    expect(supplementary.status).toBe(201);
    expect(await supplementary.json()).toMatchObject({ kind: "supplementary", totalCents: 1_000 });
  });

  it("never bill a charge twice", async () => {
    await charge("consultation");
    await draft("interim");

    expect(await refusal(await draft("interim"))).toEqual([409, "nothing_to_bill"]);
  });

  it("keep a billed charge until its invoice is voided", async () => {
    const chargeId = await charge("consultation");
    const { id } = await (await draft("final")).json();

    const cancel = () => call("POST", `/charges/${chargeId}/cancel`, h.facility.id, h.clerk, { reason: "Posted in error" });
    expect(await refusal(await cancel())).toEqual([409, "on_invoice"]);

    await voidIt(id);
    expect((await cancel()).status).toBe(200);
  });

  it("void a finalised invoice only by finance, keeping its number and voiding its document", async () => {
    await charge("consultation");
    const { id } = await (await draft("final")).json();
    await finalise(id);

    expect((await voidIt(id, h.clerk)).status).toBe(403);
    const voided = await voidIt(id, h.finance);
    expect(voided.status).toBe(200);
    expect(await voided.json()).toMatchObject({ status: "void", number: `INV-${year()}-000001`, voidReason: "Wrong bill", balanceCents: null });
    expect(await refusal(await voidIt(id, h.finance))).toEqual([409, "already_void"]);

    const [invoice] = await db.select().from(invoices).where(eq(invoices.id, id));
    const [document] = await db.select().from(documents).where(eq(documents.id, invoice.documentId!));
    expect(document.voidReason).toBe("Wrong bill");

    // Its charges are free to be billed again, under a new number.
    const rebilled = await (await draft("final")).json();
    expect((await (await finalise(rebilled.id)).json()).number).toBe(`INV-${year()}-000002`);
  });

  it("are not drafted for a cancelled encounter", async () => {
    await call("POST", `/encounters/${encounterId}/cancel`, h.facility.id, h.nurse, { reason: "Opened in error" });

    expect(await refusal(await draft("final"))).toEqual([409, "encounter_cancelled"]);
  });

  it("are drafted by billing staff and read by those who keep the money", async () => {
    await charge("consultation");

    expect((await draft("final", encounterId, h.nurse)).status).toBe(403);
    expect((await draft("final", encounterId, h.auditor)).status).toBe(403);
    const { id } = await (await draft("final", encounterId, h.clerk)).json();

    expect((await call("GET", `/invoices/${id}`, h.facility.id, h.auditor)).status).toBe(200);
    expect((await call("GET", `/invoices/${id}`, h.facility.id, h.nurse)).status).toBe(403);
    expect((await call("GET", `/encounters/${encounterId}/invoices`, h.facility.id, h.nurse)).status).toBe(403);
    expect((await finalise(id, h.auditor)).status).toBe(403);
  });

  it("audit every look", async () => {
    await charge("consultation");
    const { id } = await (await draft("final")).json();

    await call("GET", `/invoices/${id}`, h.facility.id, h.auditor);
    const listed = await (await call("GET", `/encounters/${encounterId}/invoices`, h.facility.id, h.auditor)).json();

    expect(listed.invoices).toMatchObject([{ id, status: "draft", totalCents: 50_000, number: null }]);
    const looks = await db.select().from(auditLog).where(and(eq(auditLog.actorId, h.auditor.id)));
    expect(looks.map(l => l.action).sort()).toEqual(["encounter.viewed", "invoice.viewed"]);
  });

  it("are not found from another facility", async () => {
    await charge("consultation");
    const { id } = await (await draft("final")).json();
    const elsewhere = await hospital();

    expect((await call("GET", `/invoices/${id}`, elsewhere.facility.id, elsewhere.auditor)).status).toBe(404);
    expect((await call("POST", `/invoices/${id}/finalise`, elsewhere.facility.id, elsewhere.cashier)).status).toBe(404);
  });

  it("bill an admission's nights at discharge", async () => {
    const patientId = await h.patient();
    const admitted = await runAsFacility(h.facility.id, tx =>
      admitPatient(tx, h.facility.id, { patientId, bedId: h.beds.general }, h.nurse.actor, at(0, 10)));
    // Two midnights in a General bed (the tariff starts today).
    await runAsFacility(h.facility.id, tx =>
      dischargePatient(tx, h.facility.id, admitted.encounterId, "home", h.nurse.actor, at(2, 9)));

    const { id } = await (await draft("final", admitted.encounterId)).json();
    await finalise(id);

    const [invoice] = await db.select().from(invoices).where(eq(invoices.id, id));
    const [document] = await db.select().from(documents).where(eq(documents.id, invoice.documentId!));
    expect(invoice.totalCents).toBe(500_000);
    expect(document.content.fields).toContainEqual({
      label: "Visit",
      value: expect.stringMatching(new RegExp(`^Admission ADM-${year()}-0001, .+ to .+$`)),
    });
  });
});
