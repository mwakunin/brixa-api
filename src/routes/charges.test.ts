import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { Hospital, Person } from "@/test/hospital";

import db, { pool } from "@/db";
import { auditLog, charges, jobFailures } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import { accrueAllBedDays } from "@/jobs/bed-days";
import { accrueBedDays } from "@/lib/charges";
import { addDays } from "@/lib/dates";
import { admitPatient, dischargePatient, transferPatient } from "@/lib/encounters";
import { resetDb } from "@/test/helpers";
import { at, call, hospital, TODAY } from "@/test/hospital";

describe("charges posted by hand", () => {
  let h: Hospital;
  let encounterId: string;

  beforeEach(async () => {
    await resetDb();
    h = await hospital();
    encounterId = (await (await call("POST", "/encounters", h.facility.id, h.nurse, { patientId: await h.patient(), kind: "opd" })).json()).id;
  });

  const post = (body: Record<string, unknown>, as: Person = h.clerk) =>
    call("POST", `/encounters/${encounterId}/charges`, h.facility.id, as, { reason: "Consultation before P3", ...body });

  it("copy today's price and are audited", async () => {
    const res = await post({ billableItemId: h.items.consultation, quantity: "1" });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ code: "CONS", unitPriceCents: 50_000, amountCents: 50_000, serviceDate: TODAY, bedDay: false });
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "charge.posted"));
    expect(entry).toMatchObject({ actorId: h.clerk.id, detail: { code: "CONS", amountCents: 50_000 } });
  });

  it("round each charge once, to whole shillings", async () => {
    const res = await post({ billableItemId: h.items.tablet, quantity: "3" });

    // 3 × KES 2.50 = KES 7.50, charged as KES 8.
    expect(await res.json()).toMatchObject({ quantity: "3.000", unitPriceCents: 250, amountCents: 800 });
  });

  it.each([
    ["an item the cash list does not price", { billableItemId: "unpriced", quantity: "1", days: 0 }, "not_covered"],
    ["a service date in the future", { billableItemId: "consultation", quantity: "1", days: 1 }, "service_date_invalid"],
    ["a service date before the visit", { billableItemId: "consultation", quantity: "1", days: -1 }, "service_date_invalid"],
  ])("refuse %s", async (_label, { days, ...body }, code) => {
    // Dated when the test runs, not when the file loaded: a run can cross midnight in Nairobi.
    const res = await post({ ...body, serviceDate: addDays(TODAY, days), billableItemId: h.items[body.billableItemId as keyof Hospital["items"]] });

    expect([res.status, (await res.json()).code]).toEqual([409, code]);
  });

  it("are not posted by a nurse", async () => {
    expect((await post({ billableItemId: h.items.consultation, quantity: "1" }, h.nurse)).status).toBe(403);
  });

  it("are cancelled once, for a reason, and leave the total", async () => {
    const charge = await (await post({ billableItemId: h.items.consultation, quantity: "1" })).json();
    await post({ billableItemId: h.items.tablet, quantity: "2" });

    expect((await call("POST", `/charges/${charge.id}/cancel`, h.facility.id, h.clerk, { reason: "Posted twice" })).status).toBe(200);
    expect((await call("POST", `/charges/${charge.id}/cancel`, h.facility.id, h.clerk, { reason: "Again" })).status).toBe(409);

    const list = await (await call("GET", `/encounters/${encounterId}/charges`, h.facility.id, h.nurse)).json();
    expect(list.totalCents).toBe(500);
    expect(list.charges.map((c: { cancellationReason: string | null }) => c.cancellationReason)).toEqual(["Posted twice", null]);
  });

  it("keep an encounter from being cancelled until they are", async () => {
    const charge = await (await post({ billableItemId: h.items.consultation, quantity: "1" })).json();

    const refused = await call("POST", `/encounters/${encounterId}/cancel`, h.facility.id, h.nurse, { reason: "Wrong patient" });
    expect([refused.status, (await refused.json()).code]).toEqual([409, "has_charges"]);

    await call("POST", `/charges/${charge.id}/cancel`, h.facility.id, h.clerk, { reason: "Wrong patient" });
    expect((await call("POST", `/encounters/${encounterId}/cancel`, h.facility.id, h.nurse, { reason: "Wrong patient" })).status).toBe(200);
  });

  it("change in the database only by being cancelled", async () => {
    const charge = await (await post({ billableItemId: h.items.consultation, quantity: "1" })).json();

    await expect(pool.query("UPDATE charges SET amount_cents = 100 WHERE id = $1", [charge.id])).rejects.toMatchObject({ code: "23001" });
    await call("POST", `/charges/${charge.id}/cancel`, h.facility.id, h.clerk, { reason: "Posted twice" });
    await expect(pool.query("UPDATE charges SET cancellation_reason = 'x' WHERE id = $1", [charge.id])).rejects.toMatchObject({ code: "23001" });
  });

  it("are cancelled in the database only with a reason", async () => {
    const charge = await (await post({ billableItemId: h.items.consultation, quantity: "1" })).json();

    await expect(pool.query("UPDATE charges SET cancelled_at = now(), cancelled_by = captured_by WHERE id = $1", [charge.id]))
      .rejects
      .toMatchObject({ code: "23514" });
  });

  it("refuse a charge over KES 20 million as a conflict", async () => {
    // 50,000 consultations at KES 500.
    const res = await post({ billableItemId: h.items.consultation, quantity: "50000" });

    expect([res.status, (await res.json()).code]).toEqual([409, "amount_too_large"]);
  });

  it("are not dated after the visit ended", async () => {
    const patientId = await h.patient();
    const { encounterId: stay } = await runAsFacility(h.facility.id, t =>
      admitPatient(t, h.facility.id, { patientId, bedId: h.beds.general }, h.nurse.actor, at(-2, 10)));
    await runAsFacility(h.facility.id, t => dischargePatient(t, h.facility.id, stay, "home", h.nurse.actor, at(-1, 9)));

    const res = await call("POST", `/encounters/${stay}/charges`, h.facility.id, h.clerk, {
      billableItemId: h.items.consultation,
      quantity: "1",
      reason: "Late entry",
      serviceDate: TODAY,
    });
    expect([res.status, (await res.json()).code]).toEqual([409, "service_date_invalid"]);
  });
});

describe("bed-days", () => {
  let h: Hospital;

  beforeEach(async () => {
    await resetDb();
    h = await hospital();
  });

  const tx = <T>(fn: Parameters<typeof runAsFacility<T>>[1]) => runAsFacility(h.facility.id, fn);

  async function admitted(bed = h.beds.general, when = at(0, 10)) {
    const patientId = await h.patient();
    const { encounterId } = await tx(t => admitPatient(t, h.facility.id, { patientId, bedId: bed }, h.nurse.actor, when));
    return encounterId;
  }

  async function nights(encounterId: string) {
    const rows = await db.select().from(charges).where(eq(charges.encounterId, encounterId));
    return rows.filter(r => r.bedStayId).map(r => [r.serviceDate, r.amountCents]).sort();
  }

  it("charge one per midnight in a bed, dated the day the night began", async () => {
    const encounterId = await admitted();

    await tx(t => accrueBedDays(t, h.facility.id, encounterId, at(3, 2)));

    expect(await nights(encounterId)).toEqual([
      [TODAY, 250_000],
      [addDays(TODAY, 1), 250_000],
      [addDays(TODAY, 2), 250_000],
    ]);
  });

  it("charge a stay that ends before its first midnight as one day", async () => {
    const encounterId = await admitted();

    await tx(t => dischargePatient(t, h.facility.id, encounterId, "home", h.nurse.actor, at(0, 18)));

    expect(await nights(encounterId)).toEqual([[TODAY, 250_000]]);
  });

  it("charge each night at the rate of the ward the patient is in at midnight", async () => {
    const encounterId = await admitted();
    await tx(t => transferPatient(t, h.facility.id, encounterId, h.beds.private, h.nurse.actor, at(1, 15)));

    await tx(t => dischargePatient(t, h.facility.id, encounterId, "home", h.nurse.actor, at(2, 11)));

    expect(await nights(encounterId)).toEqual([
      [TODAY, 250_000],
      [addDays(TODAY, 1), 600_000],
    ]);
  });

  it("charge nothing twice, however often or however concurrently they run", async () => {
    const encounterId = await admitted();
    await tx(t => accrueBedDays(t, h.facility.id, encounterId, at(2, 2)));

    const again = await tx(t => accrueBedDays(t, h.facility.id, encounterId, at(2, 2)));
    await Promise.all([1, 2, 3].map(() => tx(t => accrueBedDays(t, h.facility.id, encounterId, at(3, 2)))));

    expect(again.created).toEqual([]);
    expect(await nights(encounterId)).toHaveLength(3);
  });

  it("record a night they cannot price once, and charge it once the ward is set up", async () => {
    const encounterId = await admitted(h.beds.unrated);

    for (let run = 0; run < 2; run += 1)
      await tx(t => accrueBedDays(t, h.facility.id, encounterId, at(1, 2)));

    const failures = await db.select().from(jobFailures);
    expect(failures).toEqual([expect.objectContaining({ job: "bed_day_accrual", subjectId: encounterId, error: "Ward Unrated has no bed-day item" })]);
    expect(await nights(encounterId)).toEqual([]);

    const { wards } = await (await call("GET", "/wards", h.facility.id, h.admin)).json();
    const unrated = wards.find((w: { name: string }) => w.name === "Unrated");
    await call("PATCH", `/wards/${unrated.id}`, h.facility.id, h.admin, { bedDayItemId: h.items.generalNight });
    await tx(t => accrueBedDays(t, h.facility.id, encounterId, at(1, 2)));
    expect(await nights(encounterId)).toEqual([[TODAY, 250_000]]);
  });

  it("are retried after discharge until the night is charged, and the failure resolved", async () => {
    const encounterId = await admitted(h.beds.unrated);
    await tx(t => dischargePatient(t, h.facility.id, encounterId, "home", h.nurse.actor, at(1, 9)));
    expect(await db.select().from(jobFailures)).toMatchObject([{ subjectId: encounterId, resolvedAt: null }]);

    const { wards } = await (await call("GET", "/wards", h.facility.id, h.admin)).json();
    const unrated = wards.find((w: { name: string }) => w.name === "Unrated");
    await call("PATCH", `/wards/${unrated.id}`, h.facility.id, h.admin, { bedDayItemId: h.items.generalNight });
    const tally = await accrueAllBedDays(at(2, 1));

    expect(tally).toMatchObject({ charged: 1, missing: 0, failed: 0 });
    expect(await nights(encounterId)).toEqual([[TODAY, 250_000]]);
    const [failure] = await db.select().from(jobFailures);
    expect(failure.resolvedAt).not.toBeNull();
  });

  it("are charged for every open admission by the nightly run", async () => {
    const first = await admitted(h.beds.general);
    const second = await admitted(h.beds.private);

    const tally = await accrueAllBedDays(at(1, 1));

    expect(tally).toMatchObject({ charged: 2, missing: 0, failed: 0 });
    expect(await nights(first)).toEqual([[TODAY, 250_000]]);
    expect(await nights(second)).toEqual([[TODAY, 600_000]]);
  });

  describe("the nightly run", () => {
    /** Runs `fn` while the database refuses `encounterId`'s charges, as a stand-in for any failure. */
    async function refusingChargesFor<T>(encounterId: string, fn: () => Promise<T>): Promise<T> {
      await pool.query(`CREATE FUNCTION test_refuse_charge() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.encounter_id = '${encounterId}' THEN RAISE EXCEPTION 'refused for the test'; END IF; RETURN NEW; END $$`);
      await pool.query("CREATE TRIGGER test_refuse_charge BEFORE INSERT ON charges FOR EACH ROW EXECUTE FUNCTION test_refuse_charge()");
      try {
        return await fn();
      }
      finally {
        await pool.query("DROP TRIGGER test_refuse_charge ON charges");
        await pool.query("DROP FUNCTION test_refuse_charge()");
      }
    }

    const failures = async () => (await pool.query<{ subject_id: string | null; error: string; failed_at: Date; resolved_at: Date | null }>(
      "SELECT subject_id, error, failed_at, resolved_at FROM job_failures WHERE job = 'bed_day_accrual' ORDER BY error",
    )).rows;

    it("charges each admission on its own, so one that fails leaves the rest charged and is named", async () => {
      const broken = await admitted(h.beds.general);
      const fine = await admitted(h.beds.private);

      const tally = await refusingChargesFor(broken, () => accrueAllBedDays(at(1, 1)));

      expect(tally).toMatchObject({ facilities: 1, charged: 1, failed: 1 });
      expect(await nights(broken)).toEqual([]);
      expect(await nights(fine)).toEqual([[TODAY, 600_000]]);
      expect(await failures()).toMatchObject([{ subject_id: broken, resolved_at: null }]);

      // The next clean run charges it and resolves the failure.
      expect(await accrueAllBedDays(at(1, 1))).toMatchObject({ charged: 1, failed: 0 });
      expect(await nights(broken)).toEqual([[TODAY, 250_000]]);
      expect((await failures())[0].resolved_at).not.toBeNull();
    });

    it("resolves a facility's earlier failure once a later run succeeds, not one recorded since", async () => {
      await pool.query(
        `INSERT INTO job_failures (facility_id, job, error, failed_at) VALUES
           ($1, 'bed_day_accrual', 'earlier', now() - interval '1 day'),
           ($1, 'bed_day_accrual', 'overlapping', now() + interval '1 hour')`,
        [h.facility.id],
      );

      expect(await accrueAllBedDays()).toMatchObject({ failed: 0 });

      const rows = await failures();
      expect(rows.map(r => [r.error, r.resolved_at !== null])).toEqual([["earlier", true], ["overlapping", false]]);
    });

    it("leaves a night it cannot price open through a clean run", async () => {
      const encounterId = await admitted(h.beds.unrated);
      await accrueAllBedDays(at(1, 1));
      await pool.query("UPDATE job_failures SET failed_at = now() - interval '1 day'");

      expect(await accrueAllBedDays(at(1, 1))).toMatchObject({ missing: 1, failed: 0 });

      expect(await failures()).toMatchObject([{ subject_id: encounterId, error: "Ward Unrated has no bed-day item", resolved_at: null }]);
    });

    it("keeps a failure met again open with the time it was met, so a clean run that began before leaves it", async () => {
      const broken = await admitted();
      let metAgainFrom: Date;
      await refusingChargesFor(broken, async () => {
        await accrueAllBedDays(at(1, 1));
        // As if first met long ago; an overlapping run now meets it again.
        await pool.query("UPDATE job_failures SET failed_at = now() - interval '1 day'");
        metAgainFrom = (await pool.query<{ t: Date }>("SELECT now() AS t")).rows[0].t;
        expect(await accrueAllBedDays(at(1, 1))).toMatchObject({ charged: 0, failed: 1 });
      });

      const rows = await failures();
      expect(rows).toHaveLength(1);
      expect(rows[0].resolved_at).toBeNull();
      // A clean run resolves only failures met before it began: this one now counts as met just now.
      expect(rows[0].failed_at.getTime()).toBeGreaterThanOrEqual(metAgainFrom!.getTime());
    });

    it("never moves a failure met again back in time", async () => {
      const broken = await admitted();
      await refusingChargesFor(broken, async () => {
        await accrueAllBedDays(at(1, 1));
        // As if an overlapping run met it later and wrote first; this run's write lands after.
        await pool.query("UPDATE job_failures SET failed_at = now() + interval '1 hour'");
        await accrueAllBedDays(at(1, 1));
      });

      const { rows } = await pool.query("SELECT failed_at > now() + interval '30 minutes' AS later, resolved_at IS NULL AS open FROM job_failures");
      expect(rows).toEqual([{ later: true, open: true }]);
    });

    it("carries on to the next facility when one facility's failures cannot be resolved", async () => {
      const other = await hospital();
      const stays = [await admitted()];
      const { encounterId } = await runAsFacility(other.facility.id, async t =>
        admitPatient(t, other.facility.id, { patientId: await other.patient(), bedId: other.beds.general }, other.nurse.actor, at(0, 10)));
      stays.push(encounterId);
      await pool.query("INSERT INTO job_failures (facility_id, job, error, failed_at) SELECT id, 'bed_day_accrual', 'earlier', now() - interval '1 day' FROM facilities");
      // Resolving touches job_failures with an UPDATE; refuse every one.
      await pool.query(`CREATE FUNCTION test_refuse_resolve() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'refused for the test'; END $$`);
      await pool.query("CREATE TRIGGER test_refuse_resolve BEFORE UPDATE ON job_failures FOR EACH ROW EXECUTE FUNCTION test_refuse_resolve()");
      try {
        expect(await accrueAllBedDays(at(1, 1))).toMatchObject({ facilities: 2, charged: 2, failed: 2 });
      }
      finally {
        await pool.query("DROP TRIGGER test_refuse_resolve ON job_failures");
        await pool.query("DROP FUNCTION test_refuse_resolve()");
      }
      for (const stay of stays)
        expect(await nights(stay)).toHaveLength(1);
    });
  });

  it("are charged only from a bed-day item", async () => {
    const res = await call("PATCH", `/wards/${(await (await call("GET", "/wards", h.facility.id, h.admin)).json()).wards[0].id}`, h.facility.id, h.admin, {
      bedDayItemId: h.items.consultation,
    });

    expect([res.status, (await res.json()).code]).toEqual([409, "not_a_bed_day_item"]);
  });
});
