import { and, eq, inArray, isNull } from "drizzle-orm";

import db from "@/db";
import { facilities, jobFailures } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import { errorLine } from "@/lib/error-summary";
import { logger } from "@/lib/logger";
import { reconcile } from "@/lib/reconciliation";

/**
 * The daily reconciliation check (CLAUDE.md §7): every facility's money
 * identities, each facility in its own tenant transaction. A finding is kept
 * in `job_failures` until a later run no longer finds it, and is logged as
 * "money identities drifted" for alerting, with ids and counts only.
 */

/** Findings per insert: well inside Postgres's limit on bind parameters (four per row). */
const FINDINGS_PER_INSERT = 500;

export async function reconcileAll() {
  const tally = { facilities: 0, drifted: 0, findings: 0, failed: 0 };
  const all = await db.select({ id: facilities.id }).from(facilities);

  for (const facility of all) {
    tally.facilities += 1;
    try {
      const drift = await runAsFacility(facility.id, async (tx) => {
        const { drift } = await reconcile(tx);
        const current = new Set(drift.map(d => `${d.subjectId}|${d.detail}`));
        const open = await tx
          .select()
          .from(jobFailures)
          .where(and(eq(jobFailures.job, "reconciliation"), isNull(jobFailures.resolvedAt)));
        // In bulk, so a bad night's many findings cost a few statements, not one round trip each.
        const fixed = open.filter(row => !current.has(`${row.subjectId}|${row.error}`)).map(row => row.id);
        if (fixed.length > 0)
          await tx.update(jobFailures).set({ resolvedAt: new Date() }).where(inArray(jobFailures.id, fixed));
        for (let i = 0; i < drift.length; i += FINDINGS_PER_INSERT) {
          await tx.insert(jobFailures)
            .values(drift.slice(i, i + FINDINGS_PER_INSERT).map(finding => ({
              facilityId: facility.id,
              job: "reconciliation" as const,
              subjectId: finding.subjectId,
              error: finding.detail,
            })))
            .onConflictDoNothing();
        }
        return drift;
      });
      if (drift.length > 0) {
        tally.drifted += 1;
        tally.findings += drift.length;
        const identities = Object.fromEntries([...new Set(drift.map(d => d.identity))].map(i => [i, drift.filter(d => d.identity === i).length]));
        logger.error({ facilityId: facility.id, identities, subjectIds: drift.slice(0, 20).map(d => d.subjectId) }, "money identities drifted");
      }
    }
    catch (err) {
      tally.failed += 1;
      const error = errorLine(err);
      logger.error({ facilityId: facility.id, job: "reconciliation", error }, "job failed for a facility");
      // Recording it must not stop the other facilities' checks; the log line above is the alert.
      await db.insert(jobFailures).values({ facilityId: facility.id, job: "reconciliation", error }).onConflictDoNothing().catch((recordErr: unknown) => {
        logger.error({ facilityId: facility.id, job: "reconciliation", error: errorLine(recordErr) }, "could not record a job failure");
      });
    }
  }
  return tally;
}
