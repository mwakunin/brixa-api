import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { appPool, pool } from "@/db";
import { runAsFacility } from "@/db/tenant-transaction";
import { pgErrorCode } from "@/lib/db-errors";
import { backendPid, makeFacility, resetDb, waitForBlockedBackend } from "@/test/helpers";

import type { ResetPeriod } from "./number-series";

import { formatNumber, issueNumber, periodOf, registerSeries, SeriesNotRegisteredError } from "./number-series";

async function register(facilityId: string, options: { prefix?: string; resetPeriod?: ResetPeriod; startAt?: number; padding?: number } = {}) {
  await runAsFacility(facilityId, tx => registerSeries(tx, {
    facilityId,
    kind: "outpatient",
    prefix: options.prefix ?? "OP",
    resetPeriod: options.resetPeriod ?? "never",
    startAt: options.startAt,
    padding: options.padding,
    at: new Date("2026-06-01T09:00:00Z"),
  }));
}

function issue(facilityId: string, at?: Date) {
  return runAsFacility(facilityId, tx => issueNumber(tx, facilityId, "outpatient", at));
}

describe("number formatting", () => {
  it.each([
    ["OP", null, 42, 4, "OP0042"],
    ["ADM-", "2026", 153, 4, "ADM-2026-0153"],
    ["L-", "20261103", 17, 3, "L-20261103-017"],
    // Grows past its width rather than truncating.
    ["OP", null, 12345, 4, "OP12345"],
  ])("%s + %s + %d at width %d is %s", (prefix, label, value, padding, expected) => {
    expect(formatNumber(prefix, label, value, padding)).toBe(expected);
  });

  it("takes the period from the Kenyan calendar, not UTC", () => {
    // 01:00 on 1 January in Nairobi is still 31 December in UTC.
    const newYear = new Date("2026-12-31T22:00:00Z");
    expect(periodOf("yearly", newYear)).toEqual({ key: "2027", label: "2027" });
    expect(periodOf("daily", newYear)).toEqual({ key: "2027-01-01", label: "20270101" });
    expect(periodOf("never", newYear)).toEqual({ key: "all", label: null });
  });
});

describe("issuing numbers", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("issues a facility's numbers in sequence from where its register left off", async () => {
    const facility = await makeFacility();
    await register(facility.id, { startAt: 41 });

    expect(await issue(facility.id)).toBe("OP0041");
    expect(await issue(facility.id)).toBe("OP0042");
  });

  it("does not burn a number when the transaction rolls back", async () => {
    const facility = await makeFacility();
    await register(facility.id);

    await expect(runAsFacility(facility.id, async (tx) => {
      await issueNumber(tx, facility.id, "outpatient");
      throw new Error("registration failed after the number was issued");
    })).rejects.toThrow("registration failed");

    // The series has no gap to explain.
    expect(await issue(facility.id)).toBe("OP0001");
  });

  it("restarts a yearly series in the new Kenyan year", async () => {
    const facility = await makeFacility();
    await register(facility.id, { prefix: "ADM-", resetPeriod: "yearly" });

    expect(await issue(facility.id, new Date("2026-12-31T20:00:00Z"))).toBe("ADM-2026-0001");
    expect(await issue(facility.id, new Date("2026-12-31T20:30:00Z"))).toBe("ADM-2026-0002");
    // 01:00 on 1 January in Nairobi.
    expect(await issue(facility.id, new Date("2026-12-31T22:00:00Z"))).toBe("ADM-2027-0001");
  });

  it("makes a concurrent issuer wait, then gives it the next number", async () => {
    const facility = await makeFacility();
    await register(facility.id);

    let releaseFirst!: () => void;
    const firstMayCommit = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstPid = 0;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });

    const first = runAsFacility(facility.id, async (tx) => {
      const number = await issueNumber(tx, facility.id, "outpatient");
      firstPid = await backendPid(tx);
      firstStarted();
      await firstMayCommit;
      return number;
    });

    await started;
    const second = issue(facility.id);

    // The second is queued on the counter row's lock, not racing past it.
    expect(await waitForBlockedBackend(firstPid)).toBe(true);
    releaseFirst();

    expect(await first).toBe("OP0001");
    expect(await second).toBe("OP0002");
  });

  it("refuses a kind the facility has not registered", async () => {
    const facility = await makeFacility();

    await expect(issue(facility.id)).rejects.toBeInstanceOf(SeriesNotRegisteredError);
  });

  it("cannot issue from another facility's series", async () => {
    const alpha = await makeFacility();
    const beta = await makeFacility();
    await register(beta.id);

    // Asking alpha's transaction for beta's series by beta's id: RLS hides it.
    await expect(runAsFacility(alpha.id, tx => issueNumber(tx, beta.id, "outpatient")))
      .rejects
      .toBeInstanceOf(SeriesNotRegisteredError);
  });

  it("refuses a counter that points at another facility's series", async () => {
    const alpha = await makeFacility();
    const beta = await makeFacility();
    await register(beta.id);
    const { rows: [series] } = await pool.query<{ id: string }>(
      "SELECT id FROM number_series WHERE facility_id = $1",
      [beta.id],
    );

    // The composite foreign key, not a policy: the row's own facility_id is
    // alpha's and passes every WITH CHECK.
    const err = await runAsFacility(alpha.id, tx => tx.execute(sql`
      INSERT INTO number_series_counters (facility_id, series_id, period_key)
      VALUES (${alpha.id}, ${series.id}, '2030')
    `)).then(() => null, (e: unknown) => e);

    expect(pgErrorCode(err)).toBe("23503");
  });

  it("never lets a counter run backwards, even for the owner", async () => {
    const facility = await makeFacility();
    await register(facility.id, { startAt: 50 });

    // A rewound counter would issue a number, possibly a fiscal one, twice.
    const asApp = await runAsFacility(facility.id, tx => tx.execute(sql`
      UPDATE number_series_counters SET next_value = 1
    `)).then(() => null, (e: unknown) => e);
    const asOwner = await pool.query("UPDATE number_series_counters SET next_value = 1")
      .then(() => null, (e: unknown) => e);

    expect(pgErrorCode(asApp)).toBe("23001");
    expect(pgErrorCode(asOwner)).toBe("23001");
    expect(await issue(facility.id)).toBe("OP0050");
  });

  it("lets the facility change a prefix going forward, but not what a series is", async () => {
    const facility = await makeFacility();
    await register(facility.id);
    expect(await issue(facility.id)).toBe("OP0001");

    await runAsFacility(facility.id, tx => tx.execute(sql`UPDATE number_series SET prefix = 'OPD'`));
    expect(await issue(facility.id)).toBe("OPD0002");

    // Not a privilege the runtime role holds at all.
    const resetChange = await runAsFacility(facility.id, tx => tx.execute(sql`
      UPDATE number_series SET reset_period = 'yearly'
    `)).then(() => null, (e: unknown) => e);
    expect(pgErrorCode(resetChange)).toBe("42501");
  });

  it("gives the runtime role no DELETE on a counter", async () => {
    const { rows } = await appPool.query<{ has: boolean }>(
      "SELECT has_table_privilege(current_user, 'number_series_counters', 'DELETE') AS has",
    );
    expect(rows[0].has).toBe(false);
  });
});
