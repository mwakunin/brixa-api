import { eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { Hospital, StaffMember } from "@/test/hospital";

import db from "@/db";
import { auditLog, billableItems, stockItems } from "@/db/schema";
import { addDays, businessDate } from "@/lib/dates";
import { loadDrugCatalogue } from "@/lib/drug-catalogue-load";
import { addMembership, resetDb, signedInUser } from "@/test/helpers";
import { call, hospital } from "@/test/hospital";

/** P4 slice 1c: a facility's item list imported from a CSV. */

const SAMPLE = path.resolve(import.meta.dirname, "../test/fixtures/drug-catalogue-sample.csv");
const HEADER = "code,name,category,drug_code,base_unit,pack_size,unit_price";

let h: Hospital;
let pharmacist: StaffMember;

beforeEach(async () => {
  await resetDb();
  await loadDrugCatalogue(await readFile(SAMPLE, "utf8"));
  h = await hospital();
  const user = await signedInUser();
  const membership = await addMembership(user.id, h.facility.id, ["pharmacist"]);
  pharmacist = { ...user, actor: { userId: user.id, membershipId: membership.id } };
});

const file = (...rows: string[]) => [HEADER, ...rows].join("\n");

const GOOD = file(
  "AMX-500,Amoxicillin 500 mg capsules,drug,AMX-500-CAP,capsule,100,5",
  "\"ORS\",\"Oral rehydration salts, sachet\",drug,ORS-SACH,sachet,50,12.50",
  "GLV-M,\"Gloves, examination, medium\",consumable,,pair,50,",
  // The hospital's own tablet item, priced at KES 2.50 already: matched, its price left alone.
  "PCM-500,Paracetamol 500 mg tablets,drug,PCM-500-TAB,tablet,1000,2.50",
);

const preview = (csv: string, who: StaffMember = h.admin) => call("POST", "/stock-items/import/preview", h.facility.id, who, { csv });
function importFile(csv: string, extra: Record<string, unknown> = {}, who: StaffMember = h.admin) {
  return call("POST", "/stock-items/import", h.facility.id, who, { csv, ...extra });
}

describe("previewing an item list", () => {
  it("says what each row would do, and writes nothing", async () => {
    const res = await preview(GOOD);

    expect(res.status).toBe(200);
    const { rows } = await res.json();
    expect(rows.map((r: Record<string, unknown>) => [r.row, r.code, r.action, r.requestedPriceCents, r.problems])).toEqual([
      [2, "AMX-500", "create", 500, []],
      [3, "ORS", "create", 1250, []],
      [4, "GLV-M", "create", null, []],
      [5, "PCM-500", "add_stock_item", null, []],
    ]);
    expect(await db.select().from(stockItems)).toEqual([]);
  });

  it("lists every problem in the file, and suggests catalogue drugs for a drug it cannot place", async () => {
    const res = await preview(file(
      "AMX-500,Amoxicillin 500 mg capsules,drug,,capsule,100,5",
      "AMX-500,Amoxicillin again,drug,AMX-500-CAP,capsule,100,5",
      "XYZ,Something,drug,NOPE-1,tablet,100,1",
      "GLV-M,Gloves,consumable,PCM-500-TAB,pair,50,1",
      "BAD,Bad price,consumable,,piece,0,2.505",
      "CONS,Consultation,drug,PCM-500-TAB,tablet,10,1",
      "MASK,Masks,service,,piece,10,1",
    ));

    const { rows } = await res.json();
    const problems = Object.fromEntries(rows.map((r: { row: number; problems: string[] }) => [r.row, r.problems]));
    expect(problems[2]).toEqual(["drug_code: needed for a drug; choose its catalogue drug"]);
    expect(rows[0].suggestions.map((s: { code: string }) => s.code)).toEqual(expect.arrayContaining(["AMX-500-CAP", "AMX-125-SUSP"]));
    expect(problems[3]).toEqual(["code AMX-500 is also on row 2"]);
    expect(problems[4]).toEqual(["drug_code: NOPE-1 is not a current catalogue drug"]);
    expect(problems[5]).toEqual(["drug_code: a consumable names no catalogue drug"]);
    expect(problems[6]).toEqual([
      "pack_size: a whole number from 1 to 1,000,000",
      "unit_price: shillings, at most two decimals (2.50), or empty for none yet",
    ]);
    expect(problems[7]).toEqual(["code CONS is already a consultation item"]);
    expect(problems[8]).toEqual(["category: drug or consumable"]);
    expect(rows.every((r: { action: unknown }) => r.action === null)).toBe(true);
  });

  it("refuses what is not this file format", async () => {
    const refusal = async (csv: string) => {
      const res = await preview(csv);
      expect(res.status).toBe(409);
      return (await res.json()).code;
    };

    expect(await refusal("code,name\nA,B")).toBe("unreadable");
    expect(await refusal(HEADER)).toBe("unreadable");
    expect(await refusal(file("\"AMX,unclosed"))).toBe("unreadable");
    expect(await refusal(file(...Array.from({ length: 5001 }, (_, i) => `C${i},Item ${i},consumable,,piece,1,`)))).toBe("unreadable");
  });

  it("is for the facility admin alone", async () => {
    expect((await preview(GOOD, pharmacist)).status).toBe(403);
    expect((await preview(GOOD, h.finance)).status).toBe(403);
    expect((await importFile(GOOD, {}, pharmacist)).status).toBe(403);
  });
});

describe("importing an item list", () => {
  it("sets up each row, and puts its prices in one change for the finance manager to approve", async () => {
    const res = await importFile(GOOD);

    expect(res.status).toBe(201);
    const result = await res.json();
    expect(result).toEqual({ created: 3, stockItemsAdded: 4, unchanged: 0, priceChangeId: expect.any(String) });

    const listed = (await (await call("GET", "/stock-items", h.facility.id, pharmacist)).json()).items;
    expect(listed.map((i: Record<string, unknown>) => [i.code, i.category, (i.drug as { code: string } | null)?.code ?? null, i.baseUnit, i.packSize])).toEqual([
      ["AMX-500", "drug", "AMX-500-CAP", "capsule", 100],
      ["GLV-M", "consumable", null, "pair", 50],
      ["ORS", "drug", "ORS-SACH", "sachet", 50],
      ["PCM-500", "drug", "PCM-500-TAB", "tablet", 1000],
    ]);
    // The matched item keeps its own name.
    expect(listed.find((i: { code: string }) => i.code === "PCM-500").name).toBe("PCM-500");

    // Unpriced until a second person approves.
    const before = (await (await call("GET", "/billable-items", h.facility.id, h.admin)).json()).items;
    expect(before.find((i: { code: string }) => i.code === "AMX-500").cashPriceCents).toBeNull();
    expect((await call("POST", `/price-changes/${result.priceChangeId}/approve`, h.facility.id, h.admin)).status).toBe(409);
    expect((await call("POST", `/price-changes/${result.priceChangeId}/approve`, h.facility.id, h.finance)).status).toBe(200);
    const after = (await (await call("GET", "/billable-items", h.facility.id, h.admin)).json()).items;
    expect(Object.fromEntries(after.map((i: { code: string; cashPriceCents: number | null }) => [i.code, i.cashPriceCents]))).toMatchObject({
      "AMX-500": 500,
      "ORS": 1250,
      "GLV-M": null,
      "PCM-500": 250,
    });

    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "stock_items.imported"));
    expect(entry).toMatchObject({ actorId: h.admin.id, detail: { rows: 4, created: ["AMX-500", "ORS", "GLV-M"], priceChangeId: result.priceChangeId } });
  });

  it("changes nothing when the same file is imported again, and asks only for a price that differs", async () => {
    await importFile(GOOD);

    expect(await (await importFile(GOOD)).json()).toEqual({ created: 0, stockItemsAdded: 0, unchanged: 4, priceChangeId: null });

    const changed = await (await importFile(GOOD.replace("capsule,100,5", "capsule,100,6"))).json();
    expect(changed).toMatchObject({ created: 0, unchanged: 4, priceChangeId: expect.any(String) });
    const change = (await (await call("GET", "/price-changes", h.facility.id, h.finance)).json()).changes.find((c: { id: string }) => c.id === changed.priceChangeId);
    expect(change.lines).toEqual([expect.objectContaining({ code: "AMX-500", unitPriceCents: 600 })]);
  });

  it("refuses the whole file over a row that disagrees with what is set up, keeping nothing", async () => {
    await importFile(file("AMX-500,Amoxicillin 500 mg capsules,drug,AMX-500-CAP,capsule,100,5"));

    const res = await importFile(file(
      "AMX-500,Amoxicillin 500 mg capsules,drug,AMX-500-CAP,strip,10,5",
      "IBU-400,Ibuprofen 400 mg tablets,drug,IBU-400-TAB,tablet,100,3",
    ));

    expect(res.status).toBe(409);
    const refusal = await res.json();
    expect(refusal).toMatchObject({ code: "has_problems", rows: [expect.objectContaining({ row: 2 })] });
    expect(refusal.rows[0].problems).toEqual([
      "code AMX-500 is already counted in capsule",
      "code AMX-500 already comes in packs of 100; change it on the item",
    ]);
    expect(await db.select().from(billableItems).where(eq(billableItems.code, "IBU-400"))).toEqual([]);
  });

  it("refuses prices that would start before today, before writing anything", async () => {
    const res = await importFile(GOOD, { effectiveFrom: addDays(businessDate(), -1) });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("effective_in_past");
    expect(await db.select().from(stockItems)).toEqual([]);

    const later = await (await importFile(GOOD, { effectiveFrom: addDays(businessDate(), 7) })).json();
    expect(later.priceChangeId).toEqual(expect.any(String));
  });
});
