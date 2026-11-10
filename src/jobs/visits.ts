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
 * Facility by facility, each in its own tenant transaction; a facility whose
 * run fails is recorded in `job_failures` and logged for an alert, and the
 * others carry on. A facility's later successful run resolves the failures
 * recorded before it began, but not one an overlapping run recorded since.
 * Idempotent: a closed visit is skipped. The OWNER
 * connection only lists facilities and records such a failure. Cloud
 * Scheduler calls it through `POST /internal/jobs/close-visits`.
 */
export async function closeStaleVisits(now = new Date()) {
  const tally = { facilities: 0, closed: 0, failed: 0 };
  const runStartedAt = new Date();
  const dayStart = startOfBusinessDay(businessDate(now));
  const all = await db.select({ id: facilities.id }).from(facilities);

  for (const facility of all) {
    tally.facilities += 1;
    try {
      tally.closed += await runAsFacility(facility.id, async (tx) => {
        const stale = await tx
          .select({ id: encounters.id })
          .from(encounters)
          .where(and(eq(encounters.kind, "opd"), eq(encounters.status, "open"), lt(encounters.startedAt, dayStart)));
        let closed = 0;
        for (const { id } of stale) {
          if (await closeStaleVisit(tx, facility.id, id, now))
            closed += 1;
        }
        await tx.update(jobFailures)
          .set({ resolvedAt: new Date() })
          .where(and(eq(jobFailures.job, "visit_close"), isNull(jobFailures.resolvedAt), lt(jobFailures.failedAt, runStartedAt)));
        return closed;
      });
    }
    catch (err) {
      tally.failed += 1;
      const error = errorLine(err);
      logger.error({ facilityId: facility.id, job: "visit_close", error }, "job failed for a facility");
      await db.insert(jobFailures).values({ facilityId: facility.id, job: "visit_close", error }).onConflictDoNothing();
    }
  }

  return tally;
}
