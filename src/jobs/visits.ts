import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import db from "@/db";
import { encounters, facilities, jobFailures } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import { businessDate, startOfBusinessDay } from "@/lib/dates";
import { closeStaleVisit } from "@/lib/encounters";
import { errorLine } from "@/lib/error-summary";
import { logger } from "@/lib/logger";
import { closeFinishedVisit, finishedVisits } from "@/lib/visit-finish";

/**
 * The nightly close of outpatient visits (CLAUDE.md §7): every OPD visit
 * opened before today, Nairobi time, and still open is closed, so yesterday's
 * patients do not linger in queues and the day's counts are final. Emergency
 * attendances and admissions are left alone: they may run overnight.
 *
 * Facility by facility, and each visit in its own tenant transaction, so one
 * visit that cannot be closed leaves the rest closed. A visit that fails, or
 * a facility whose visits cannot even be listed, is recorded in
 * `job_failures` (with the visit as its subject) and logged for an alert;
 * the run carries on. A facility's run with no failure resolves the failures
 * recorded before it began, but not one an overlapping run recorded, or met
 * again, since; if resolving fails, that too is recorded and the run carries on.
 * Idempotent: a closed visit is skipped. `now` only chooses which visits are
 * stale; each is closed at the time it is locked. The OWNER connection only lists
 * facilities and records failures. Cloud Scheduler calls it through
 * `POST /internal/jobs/close-visits`.
 */
/** What a run did; the internal route answers with it. */
export interface VisitCloseTally {
  facilities: number;
  closed: number;
  /** Facilities with a failure: a visit that would not close, or the facility itself. */
  failed: number;
}

export async function closeStaleVisits(now = new Date()): Promise<VisitCloseTally> {
  const dayStart = startOfBusinessDay(businessDate(now));
  return perVisit(
    "visit_close",
    tx => tx
      .select({ id: encounters.id })
      .from(encounters)
      .where(and(eq(encounters.kind, "opd"), eq(encounters.status, "open"), lt(encounters.startedAt, dayStart)))
      .then(rows => rows.map(r => r.id)),
    closeStaleVisit,
  );
}

/** How many finished visits one 15-minute check closes; the next check takes the rest. */
const FINISH_BATCH = 500;

/**
 * The check every 15 minutes (`POST /internal/jobs/finish-visits`): every
 * open outpatient visit with nothing pending closes itself
 * (`lib/visit-finish.ts`), each in its own transaction and re-checked once
 * locked, with failures recorded as `visit_finish` exactly as the nightly
 * close records its own. At most `limit` a run.
 */
export async function closeFinishedVisits(limit = FINISH_BATCH): Promise<VisitCloseTally> {
  return perVisit("visit_finish", tx => finishedVisits(tx, limit), closeFinishedVisit, limit);
}

/**
 * Facility by facility, lists the visits to close and closes each in its own
 * tenant transaction. A visit that fails, or a facility whose visits cannot
 * be listed, is recorded in `job_failures` (the visit as its subject) and
 * logged; the run carries on. A facility's run with no failure resolves the
 * failures recorded before it began, but not one met since. A list cut
 * short at `limit` vouches only for the visits on it: their failures are
 * resolved, the rest wait for a run that lists them all.
 */
async function perVisit(
  job: "visit_close" | "visit_finish",
  list: (tx: AppDb) => Promise<string[]>,
  close: (tx: AppDb, facilityId: string, id: string) => Promise<boolean>,
  limit = Infinity,
): Promise<VisitCloseTally> {
  const tally: VisitCloseTally = { facilities: 0, closed: 0, failed: 0 };
  // From the clock that stamps job_failures.failed_at, so the two compare like for like.
  const [{ startedAt }] = (await db.execute<{ startedAt: Date | string }>(sql`SELECT now() AS "startedAt"`)).rows;
  const runStartedAt = new Date(startedAt);
  const all = await db.select({ id: facilities.id }).from(facilities);

  for (const facility of all) {
    tally.facilities += 1;
    const failed = async (err: unknown, subjectId?: string) => {
      const error = errorLine(err);
      logger.error({ facilityId: facility.id, job, subjectId, error }, "job failed for a facility");
      // Met again, an open failure takes this run's time, never an earlier
      // one, so an overlapping clean run that began before now leaves it
      // open. The target is `job_failures_open_once`, expression and
      // predicate alike.
      await db.execute(sql`
        INSERT INTO ${jobFailures} (facility_id, job, subject_id, error)
        VALUES (${facility.id}, ${job}, ${subjectId ?? null}, ${error})
        ON CONFLICT (facility_id, job, coalesce(subject_id, '00000000-0000-0000-0000-000000000000'::uuid), error)
          WHERE resolved_at IS NULL
        DO UPDATE SET failed_at = greatest(${jobFailures}.failed_at, excluded.failed_at)`);
    };

    let ids: string[];
    try {
      ids = await runAsFacility(facility.id, list);
    }
    catch (err) {
      tally.failed += 1;
      await failed(err);
      continue;
    }

    let visitFailures = 0;
    for (const id of ids) {
      try {
        if (await runAsFacility(facility.id, tx => close(tx, facility.id, id)))
          tally.closed += 1;
      }
      catch (err) {
        visitFailures += 1;
        await failed(err, id);
      }
    }

    if (visitFailures > 0) {
      tally.failed += 1;
      continue;
    }
    const onlyListed = ids.length < limit ? undefined : inArray(jobFailures.subjectId, ids);
    try {
      await runAsFacility(facility.id, tx => tx.update(jobFailures)
        .set({ resolvedAt: new Date() })
        .where(and(eq(jobFailures.job, job), isNull(jobFailures.resolvedAt), lt(jobFailures.failedAt, runStartedAt), onlyListed)));
    }
    catch (err) {
      tally.failed += 1;
      await failed(err);
    }
  }

  return tally;
}
