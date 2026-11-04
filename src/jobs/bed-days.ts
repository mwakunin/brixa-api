import { and, eq } from "drizzle-orm";

import db from "@/db";
import { encounters, facilities, jobFailures } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import { accrueBedDays } from "@/lib/charges";
import { errorLine } from "@/lib/error-summary";
import { logger } from "@/lib/logger";

/**
 * The nightly bed-day run (CLAUDE.md §7): charges every open admission's
 * nights so far, facility by facility, each in its own tenant transaction.
 * Cloud Scheduler calls it through `POST /internal/jobs/bed-days` shortly
 * after midnight in Nairobi; discharge also charges its own nights.
 *
 * Idempotent, so a repeated or overlapping run charges nothing twice. A
 * facility whose run fails is recorded in `job_failures` and logged for an
 * alert; the others carry on. The OWNER connection is used only to list the
 * facilities and record such a failure.
 */
export async function accrueAllBedDays(now = new Date()) {
  const tally = { facilities: 0, charged: 0, missing: 0, failed: 0 };
  const all = await db.select({ id: facilities.id }).from(facilities);

  for (const facility of all) {
    tally.facilities += 1;
    try {
      await runAsFacility(facility.id, async (tx) => {
        const open = await tx
          .select({ id: encounters.id })
          .from(encounters)
          .where(and(eq(encounters.kind, "ipd"), eq(encounters.status, "open")));
        for (const encounter of open) {
          const result = await accrueBedDays(tx, facility.id, encounter.id, now);
          tally.charged += result.created.length;
          tally.missing += result.missing.length;
        }
      });
    }
    catch (err) {
      tally.failed += 1;
      const error = errorLine(err);
      logger.error({ facilityId: facility.id, job: "bed_day_accrual", error }, "job failed for a facility");
      await db.insert(jobFailures).values({ facilityId: facility.id, job: "bed_day_accrual", error }).onConflictDoNothing();
    }
  }

  return tally;
}
