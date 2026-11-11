import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";

import db from "@/db";
import { encounters, facilities, jobFailures } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import { accrueBedDays } from "@/lib/charges";
import { errorLine } from "@/lib/error-summary";
import { logger } from "@/lib/logger";

/**
 * The nightly bed-day run (CLAUDE.md §7): charges every open admission's
 * nights so far, and retries any admission, discharged or not, with an open
 * failure: a night it could not price, or a run that failed. Cloud Scheduler
 * calls it through `POST /internal/jobs/bed-days` shortly after midnight in
 * Nairobi; discharge also charges its own nights.
 *
 * Facility by facility, and each admission in its own tenant transaction, so
 * one admission that cannot be charged leaves the rest charged. An admission
 * that fails, or a facility whose admissions cannot even be listed, is
 * recorded in `job_failures` (with the admission as its subject) and logged
 * for an alert; the run carries on. An admission's failures are resolved
 * when it is next charged without one (`accrueBedDays`), except a night still
 * unpriced. A facility's run with no failure also resolves the facility's own
 * failures recorded before it began, but not one an overlapping run recorded,
 * or met again, since; if resolving fails, that too is recorded and the run
 * carries on. Idempotent, so a repeated or overlapping run charges nothing
 * twice. The OWNER connection only lists facilities and records failures.
 */
/** What a run did; the internal route answers with it. */
export interface BedDayTally {
  facilities: number;
  /** Nights charged. */
  charged: number;
  /** Nights that could not be priced; each stays a failure until it is charged. */
  missing: number;
  /** Facilities with a failure: an admission that could not be charged, or the facility itself. */
  failed: number;
}

export async function accrueAllBedDays(now = new Date()): Promise<BedDayTally> {
  const tally: BedDayTally = { facilities: 0, charged: 0, missing: 0, failed: 0 };
  // From the clock that stamps job_failures.failed_at, so the two compare like for like.
  const [{ startedAt }] = (await db.execute<{ startedAt: Date | string }>(sql`SELECT now() AS "startedAt"`)).rows;
  const runStartedAt = new Date(startedAt);
  const all = await db.select({ id: facilities.id }).from(facilities);

  for (const facility of all) {
    tally.facilities += 1;
    const failed = async (err: unknown, subjectId?: string) => {
      const error = errorLine(err);
      logger.error({ facilityId: facility.id, job: "bed_day_accrual", subjectId, error }, "job failed for a facility");
      // Met again, an open failure takes this run's time, never an earlier
      // one, so an overlapping clean run that began before now leaves it
      // open. The target is `job_failures_open_once`, expression and
      // predicate alike.
      await db.execute(sql`
        INSERT INTO ${jobFailures} (facility_id, job, subject_id, error)
        VALUES (${facility.id}, 'bed_day_accrual', ${subjectId ?? null}, ${error})
        ON CONFLICT (facility_id, job, coalesce(subject_id, '00000000-0000-0000-0000-000000000000'::uuid), error)
          WHERE resolved_at IS NULL
        DO UPDATE SET failed_at = greatest(${jobFailures}.failed_at, excluded.failed_at)`);
    };

    let due: string[];
    try {
      due = await runAsFacility(facility.id, async (tx) => {
        const open = await tx
          .select({ id: encounters.id })
          .from(encounters)
          .where(and(eq(encounters.kind, "ipd"), eq(encounters.status, "open")));
        const retried = await tx
          .selectDistinct({ id: jobFailures.subjectId })
          .from(jobFailures)
          .where(and(eq(jobFailures.job, "bed_day_accrual"), isNull(jobFailures.resolvedAt), isNotNull(jobFailures.subjectId)));
        return [...new Set([...open.map(e => e.id), ...retried.map(f => f.id!)])];
      });
    }
    catch (err) {
      tally.failed += 1;
      await failed(err);
      continue;
    }

    let admissionFailures = 0;
    for (const id of due) {
      try {
        // Counted only once the admission's transaction commits.
        const result = await runAsFacility(facility.id, tx => accrueBedDays(tx, facility.id, id, now));
        tally.charged += result.created.length;
        tally.missing += result.missing.length;
      }
      catch (err) {
        admissionFailures += 1;
        await failed(err, id);
      }
    }

    if (admissionFailures > 0) {
      tally.failed += 1;
      continue;
    }
    try {
      // The facility's own failures only: an admission's are resolved by charging it.
      await runAsFacility(facility.id, tx => tx.update(jobFailures)
        .set({ resolvedAt: new Date() })
        .where(and(
          eq(jobFailures.job, "bed_day_accrual"),
          isNull(jobFailures.subjectId),
          isNull(jobFailures.resolvedAt),
          lt(jobFailures.failedAt, runStartedAt),
        )));
    }
    catch (err) {
      tally.failed += 1;
      await failed(err);
    }
  }

  return tally;
}
