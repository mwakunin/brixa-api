import type { AppDb } from "@/db";

import { outbox } from "@/db/schema";

export type OutboxOperation = (typeof outbox.$inferInsert)["operation"];

/**
 * Records an external call to make once the current transaction commits
 * (CLAUDE.md rule 18).
 *
 * Pass the transaction that makes the business change, so the two commit
 * together: an invitation that exists always has its email queued, and one
 * that rolled back never sends. The row names an operation and a subject id
 * only; the worker re-reads everything else (rule 10).
 */
export async function enqueue(
  tx: AppDb,
  job: { facilityId: string; operation: OutboxOperation; subjectId: string },
): Promise<void> {
  await tx.insert(outbox).values(job);
}
