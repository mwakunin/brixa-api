import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { Hospital, StaffMember } from "@/test/hospital";

import db, { pool } from "@/db";
import { auditLog } from "@/db/schema";
import { addMembership, resetDb, signedInUser } from "@/test/helpers";
import { call, hospital } from "@/test/hospital";

/** P3 slice 4a: the lab's catalogue of tests, analytes, reference ranges and critical limits. */

let h: Hospital;
let supervisor: StaffMember;
let fbcItem: string;

const FBC = {
  specimenType: "blood",
  analytes: [
    {
      code: "hgb",
      name: "Haemoglobin",
      resultType: "numeric",
      unit: "g/dL",
      criticalLow: 7,
      criticalHigh: 20,
      ranges: [
        { sex: "male", ageFromDays: 6570, low: 13.5, high: 17.5 },
        { sex: "female", ageFromDays: 6570, low: 12, high: 15.5 },
      ],
    },
    { code: "COMMENT", name: "Film comment", resultType: "text" },
  ],
};

beforeEach(async () => {
  await resetDb();
  h = await hospital();
  const user = await signedInUser();
  const membership = await addMembership(user.id, h.facility.id, ["lab_supervisor"]);
  supervisor = { ...user, actor: { userId: user.id, membershipId: membership.id } };
  fbcItem = (await (await call("POST", "/billable-items", h.facility.id, h.admin, { code: "FBC", name: "Full blood count", category: "lab" })).json()).id;
});

const create = (body: Record<string, unknown>, who: StaffMember = supervisor) => call("POST", "/lab-tests", h.facility.id, who, body);

async function fbc() {
  const res = await create({ billableItemId: fbcItem, ...FBC });
  expect(res.status).toBe(201);
  return res.json();
}

describe("the lab catalogue", () => {
  it("is kept by the lab supervisor or the facility admin, on an active lab item, and read by every member", async () => {
    const test = await fbc();

    expect(test).toMatchObject({ code: "FBC", name: "Full blood count", specimenType: "blood", isActive: true, billableItemId: fbcItem });
    expect(test.analytes).toEqual([
      expect.objectContaining({
        code: "HGB",
        resultType: "numeric",
        unit: "g/dL",
        criticalLow: 7,
        criticalHigh: 20,
        ranges: [
          { sex: "female", ageFromDays: 6570, ageToDays: null, low: 12, high: 15.5 },
          { sex: "male", ageFromDays: 6570, ageToDays: null, low: 13.5, high: 17.5 },
        ],
      }),
      expect.objectContaining({ code: "COMMENT", resultType: "text", unit: null, choices: null, ranges: [] }),
    ]);
    expect((await (await call("GET", "/lab-tests", h.facility.id, h.cashier)).json()).tests).toHaveLength(1);
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "lab_test.created"));
    expect(entry).toMatchObject({ actorId: supervisor.id, detail: { code: "FBC", analytes: ["HGB", "COMMENT"] } });

    expect((await (await create({ billableItemId: fbcItem, ...FBC })).json()).code).toBe("already_a_test");
    expect((await (await create({ billableItemId: h.items.consultation, ...FBC })).json()).code).toBe("not_a_lab_item");
    const other = (await (await call("POST", "/billable-items", h.facility.id, h.admin, { code: "ESR", name: "ESR", category: "lab" })).json()).id;
    expect((await create({ billableItemId: other, ...FBC }, h.nurse)).status).toBe(403);
    expect((await create({ billableItemId: other, ...FBC }, h.admin)).status).toBe(201);
  });

  it("takes each analyte as a number, a choice or text, with only what fits it", async () => {
    const analyte = (a: Record<string, unknown>) => create({ billableItemId: fbcItem, specimenType: "blood", analytes: [a] });
    const choice = { code: "MPS", name: "Malaria parasites", resultType: "choice", choices: ["Negative", "Positive"] };

    expect((await analyte({ ...choice, unit: "g/dL" })).status).toBe(422);
    expect((await analyte({ ...choice, abnormalChoices: ["Reactive"] })).status).toBe(422);
    expect((await analyte({ ...choice, choices: ["Negative", "Negative"] })).status).toBe(422);
    expect((await analyte({ code: "HGB", name: "Hb", resultType: "numeric", criticalLow: 20, criticalHigh: 7 })).status).toBe(422);
    expect((await analyte({ code: "HGB", name: "Hb", resultType: "numeric", ranges: [{ low: 17, high: 13 }] })).status).toBe(422);
    expect((await analyte({ code: "HGB", name: "Hb", resultType: "numeric", ranges: [{ ageFromDays: 30, ageToDays: 30, low: 1 }] })).status).toBe(422);
    // Put beside the analytes, it is refused too.
    expect((await create({ billableItemId: fbcItem, specimenType: "blood", criticalHigh: 20, analytes: [FBC.analytes[1]] })).status).toBe(422);
    // A critical limit belongs on the analyte; put on a range, it is refused, not dropped.
    expect((await analyte({ code: "HGB", name: "Hb", resultType: "numeric", ranges: [{ low: 12, high: 16, criticalHigh: 20 }] })).status).toBe(422);
    expect((await create({ billableItemId: fbcItem, specimenType: "blood", analytes: [FBC.analytes[1], FBC.analytes[1]] })).status).toBe(422);
    // A limit prints exactly as entered: at most 6 decimal places.
    expect((await analyte({ code: "HGB", name: "Hb", resultType: "numeric", ranges: [{ low: 0.0000004 }] })).status).toBe(422);
    expect((await analyte({ code: "HGB", name: "Hb", resultType: "numeric", criticalLow: 1e16 })).status).toBe(422);

    const res = await analyte({ ...choice, abnormalChoices: ["Positive"] });
    expect(res.status).toBe(201);
    expect((await res.json()).analytes[0]).toMatchObject({ choices: ["Negative", "Positive"], abnormalChoices: ["Positive"], unit: null });
  });

  it("keeps one current range per sex and age, replaced as a whole set, the old ones retired", async () => {
    const test = await fbc();
    const [hgb, comment] = test.analytes;
    const setRanges = (id: string, ranges: unknown[]) => call("PUT", `/lab-analytes/${id}/ranges`, h.facility.id, supervisor, { ranges });

    const overlap = await setRanges(hgb.id, [{ sex: "any", low: 12, high: 17 }, { sex: "male", ageFromDays: 6570, low: 13.5, high: 17.5 }]);
    expect([overlap.status, (await overlap.json()).code]).toEqual([409, "ranges_overlap"]);
    expect((await (await setRanges(comment.id, [{ low: 1 }])).json()).code).toBe("not_numeric");
    // A field beside the ranges is refused, not dropped.
    expect((await call("PUT", `/lab-analytes/${hgb.id}/ranges`, h.facility.id, supervisor, { ranges: [], criticalHigh: 20 })).status).toBe(422);

    const res = await setRanges(hgb.id, [
      { sex: "any", ageFromDays: 0, ageToDays: 28, low: 14, high: 24 },
      { sex: "any", ageFromDays: 28, ageToDays: 6570, low: 11, high: 16 },
      { sex: "male", ageFromDays: 6570, low: 13.5, high: 17.5 },
    ]);

    expect(res.status).toBe(200);
    expect((await res.json()).analytes[0].ranges.map((r: { ageFromDays: number }) => r.ageFromDays)).toEqual([0, 28, 6570]);
    const { rows } = await pool.query("SELECT retired_at IS NOT NULL AS retired, count(*)::int AS n FROM lab_reference_ranges GROUP BY 1 ORDER BY 1");
    expect(rows).toEqual([{ retired: false, n: 3 }, { retired: true, n: 2 }]);
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "lab_analyte.ranges_set"));
    expect(entry.detail).toMatchObject({ before: [expect.objectContaining({ sex: "male" }), expect.objectContaining({ sex: "female" })], after: expect.any(Array) });
  });

  it("changes an analyte's wording and limits, never its kind, and retires a test from ordering", async () => {
    const test = await fbc();
    const [hgb, comment] = test.analytes;
    const change = (id: string, body: Record<string, unknown>) => call("PATCH", `/lab-analytes/${id}`, h.facility.id, supervisor, body);

    const res = await change(hgb.id, { name: "Haemoglobin (Hb)", criticalHigh: 22 });
    expect(await res.json()).toMatchObject({ analytes: [expect.objectContaining({ name: "Haemoglobin (Hb)", criticalLow: 7, criticalHigh: 22 }), expect.anything()] });
    expect((await (await change(hgb.id, { criticalLow: 30 })).json()).code).toBe("critical_limits_invalid");
    expect((await (await change(comment.id, { unit: "g/L" })).json()).code).toBe("not_numeric");
    expect((await (await change(hgb.id, { choices: ["A", "B"] })).json()).code).toBe("not_a_choice");
    expect((await change(hgb.id, { resultType: "text" })).status).toBe(422);

    const retired = await call("PATCH", `/lab-tests/${test.id}`, h.facility.id, h.admin, { isActive: false });
    expect(await retired.json()).toMatchObject({ isActive: false });
    const added = await call("POST", `/lab-tests/${test.id}/analytes`, h.facility.id, supervisor, { code: "WBC", name: "White cells", resultType: "numeric", unit: "10^9/L" });
    expect((await added.json()).analytes.map((a: { code: string }) => a.code)).toEqual(["HGB", "COMMENT", "WBC"]);
    expect((await (await call("POST", `/lab-tests/${test.id}/analytes`, h.facility.id, supervisor, { code: "WBC", name: "Again", resultType: "text" })).json()).code).toBe("code_taken");
    // At most 60 analytes a test, so an order's report always fits on its document.
    await pool.query(
      "INSERT INTO lab_analytes (facility_id, lab_test_id, code, name, position, result_type) SELECT $1, $2, 'X' || n, 'X', 10 + n, 'text' FROM generate_series(1, 57) n",
      [h.facility.id, test.id],
    );
    expect((await (await call("POST", `/lab-tests/${test.id}/analytes`, h.facility.id, supervisor, { code: "ONEMORE", name: "One more", resultType: "text" })).json()).code).toBe("too_many_analytes");
  });

  it("only ever retires a reference range, for every role", async () => {
    await fbc();
    const refusal = (query: string) => pool.query(query).then(() => "accepted", (err: { message: string }) => err.message);

    expect(await refusal("UPDATE lab_reference_ranges SET low = 1")).toMatch(/only retired/);
    expect(await refusal("DELETE FROM lab_reference_ranges")).toMatch(/never deleted/);
    await pool.query("UPDATE lab_reference_ranges SET retired_at = now()");
    expect(await refusal("UPDATE lab_reference_ranges SET retired_at = now()")).toMatch(/only retired/);
  });

  it("holds an analyte to its result type's fields, for every role", async () => {
    const test = await fbc();
    const insert = (values: string) => pool.query(
      `INSERT INTO lab_analytes (facility_id, lab_test_id, code, name, position, result_type, choices, abnormal_choices, unit)
       VALUES ($1, $2, 'X', 'X', 9, ${values})`,
      [h.facility.id, test.id],
    ).then(() => "accepted", (err: { message: string }) => err.message);

    expect(await insert("'choice', NULL, '{}', NULL")).toMatch(/lab_analytes_shape/);
    expect(await insert("'choice', '{A,B}', '{C}', NULL")).toMatch(/lab_analytes_shape/);
    expect(await insert("'text', NULL, NULL, 'g/dL'")).toMatch(/lab_analytes_shape/);
    expect(await insert("'choice', '{A,B}', '{B}', NULL")).toBe("accepted");
  });
});
