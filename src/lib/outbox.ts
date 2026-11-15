import type { AppDb } from "@/db";

import { outbox } from "@/db/schema";

import { noteQueued } from "./outbox-nudge";

export type OutboxOperation = (typeof outbox.$inferInsert)["operation"];

/**
 * Records an external call to make once the current transaction commits
 * (CLAUDE.md rule 18).
 *
 * Pass the transaction that makes the business change, so the two commit
 * together: an invitation that exists always has its email queued, and one
 * that rolled back never sends. The row names an operation and a subject id
 * only; the worker re-reads everything else (rule 10).
 *
 * Inside `runAsFacility` (or `nudgingAfterCommit`), the job is also nudged to
 * the worker as soon as the transaction commits (lib/outbox-nudge.ts).
 *
 * `availableAt` holds a job back until then (an appointment reminder, due the
 * day before). The outbox sweep delivers it once due; nudging it now would
 * only drain a queue it is not yet in.
 */
export async function enqueue(
  tx: AppDb,
  job: { facilityId: string; operation: OutboxOperation; subjectId: string; availableAt?: Date },
): Promise<void> {
  const [row] = await tx.insert(outbox).values(job).returning({ id: outbox.id });
  if (!job.availableAt || job.availableAt <= new Date())
    noteQueued(row.id);
}
