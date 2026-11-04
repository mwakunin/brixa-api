import { AsyncLocalStorage } from "node:async_hooks";

import env from "@/env";

import { createDrainTask } from "./cloud-tasks";
import { errorLine } from "./error-summary";
import { logger } from "./logger";

/**
 * Draining the outbox as soon as a job is queued: "Cloud Tasks on write,
 * plus a Scheduler sweep" (CLAUDE.md §7).
 *
 * `enqueue` notes each job it writes; the transaction wrapper calls
 * `nudgeOutbox` only once that transaction has COMMITTED, so a task never
 * races a job that is not yet visible, and a rolled-back job is never
 * nudged. The nudge is best effort: if Cloud Tasks cannot be reached, the
 * Scheduler sweep delivers the job a minute later.
 */

const queuedInThisTransaction = new AsyncLocalStorage<string[]>();

/** Called by `enqueue`: remember this job until the transaction commits. */
export function noteQueued(outboxId: string): void {
  queuedInThisTransaction.getStore()?.push(outboxId);
}

/**
 * Runs `transaction`, then nudges the jobs it queued once it has committed.
 * Not awaited: a request does not wait on Cloud Tasks to answer. `nudge` is
 * a parameter so a test can see what would be sent.
 */
export async function nudgingAfterCommit<T>(
  transaction: () => Promise<T>,
  nudge: (outboxIds: readonly string[]) => void = nudgeOutbox,
): Promise<T> {
  const queued: string[] = [];
  const result = await queuedInThisTransaction.run(queued, transaction);
  if (queued.length > 0)
    nudge(queued);
  return result;
}

/**
 * Cloud Tasks when a queue is configured (production requires one); in
 * development, a drain in this process, so an invitation email prints at
 * once; in tests, nothing, because each test drains when it means to.
 */
export function nudgeOutbox(outboxIds: readonly string[]): void {
  deliver(outboxIds).catch((err) => {
    logger.warn({ outboxIds, error: errorLine(err) }, "outbox nudge failed; the scheduled sweep will deliver");
  });
}

async function deliver(outboxIds: readonly string[]): Promise<void> {
  if (env.TASKS_QUEUE && env.TASKS_INVOKER_EMAIL) {
    const options = { queue: env.TASKS_QUEUE, invokerEmail: env.TASKS_INVOKER_EMAIL };
    await Promise.all(outboxIds.map(id => createDrainTask(id, options)));
    return;
  }

  if (env.NODE_ENV === "development") {
    // Imported here, not at the top: the worker's handlers import `enqueue`,
    // which imports this module.
    const { drainOutbox } = await import("@/jobs/outbox-worker");
    await drainOutbox();
  }
}
