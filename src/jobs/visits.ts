import { and, eq, isNull, lt } from "drizzle-orm";

import db from "@/db";
import { encounters, facilities, jobFailures } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import { businessDate, startOfBusinessDay } from "@/lib/dates";
import { closeStaleVisit } from "@/lib/encounters";
import { errorLine } from "@/lib/error-summary";
import { logger } from "@/lib/logger";

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
 * recorded before it began, but not one an overlapping run recorded since.
 * Idempotent: a closed visit is skipped. The OWNER connection only lists
 * facilities and records failures. Cloud Scheduler calls it through
 * `POST /internal/jobs/close-visits`.
 */
export async function closeStaleVisits(now = new Date()) {
  const tally = { facilities: 0, closed: 0, failed: 0 };
  const runStartedAt = new Date();
  const dayStart = startOfBusinessDay(businessDate(now));
  const all = await db.select({ id: facilities.id }).from(facilities);

  for (const facility of all) {
    tally.facilities += 1;
    const failed = async (err: unknown, subjectId?: string) => {
      const error = errorLine(err);
      logger.error({ facilityId: facility.id, job: "visit_close", subjectId, error }, "job failed for a facility");
      await db.insert(jobFailures).values({ facilityId: facility.id, job: "visit_close", subjectId, error }).onConflictDoNothing();
    };

    let stale: { id: string }[];
    try {
      stale = await runAsFacility(facility.id, tx => tx
        .select({ id: encounters.id })
        .from(encounters)
        .where(and(eq(encounters.kind, "opd"), eq(encounters.status, "open"), lt(encounters.startedAt, dayStart))));
    }
    catch (err) {
      tally.failed += 1;
      await failed(err);
      continue;
    }

    let visitFailures = 0;
    for (const { id } of stale) {
      try {
        if (await runAsFacility(facility.id, tx => closeStaleVisit(tx, facility.id, id, now)))
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
    await runAsFacility(facility.id, tx => tx.update(jobFailures)
      .set({ resolvedAt: new Date() })
      .where(and(eq(jobFailures.job, "visit_close"), isNull(jobFailures.resolvedAt), lt(jobFailures.failedAt, runStartedAt))));
  }

  return tally;
}
