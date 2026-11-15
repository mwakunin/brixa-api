import type { recordAudit } from "@/lib/audit";

import { runAsFacility } from "@/db/tenant-transaction";
import { recordAudit as record } from "@/lib/audit";

type Entry = Omit<Parameters<typeof recordAudit>[1], "facilityId">;

/**
 * Records a refusal (rule 27: a break-glass attempt or a restricted record
 * refused) in a transaction of its own. The request's transaction rolls back
 * with its 4xx (middlewares/tenant.ts), and the refusal with it, so an entry
 * written there would never be seen.
 */
export async function recordRefusal(facilityId: string, entry: Entry): Promise<void> {
  await runAsFacility(facilityId, tx => record(tx, { facilityId, ...entry }));
}
