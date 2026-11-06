import type { OutboxOperation } from "@/lib/outbox";

import { pool } from "@/db";
import { errorLine } from "@/lib/error-summary";
import { sendInvitation } from "@/lib/invitations";
import { logger } from "@/lib/logger";
import { registerUrls } from "@/lib/mpesa";
import { sendStkPush } from "@/lib/mpesa-stk";

/**
 * Drains the outbox (CLAUDE.md §7): claims due jobs, makes each call, records
 * the outcome.
 *
 * On the OWNER connection, and only for the queue itself: the worker serves
 * every facility, so it claims rows by id across tenants. It never reads a
 * facility's data on this connection. Each handler opens that facility's own
 * tenant transaction (db/tenant-transaction.ts) to re-read what it needs.
 *
 * Delivery is at least once. A worker that dies after the call and before
 * recording it leaves the job to come back when its lease runs out, so every
 * handler must be safe to run twice.
 *
 * Triggered by a Cloud Task after each commit that queues a job, and by a
 * Scheduler sweep, both through `POST /internal/outbox/drain`
 * (routes/internal.route.ts). In development it runs in-process after the
 * commit; `pnpm outbox:drain` runs it by hand.
 */

export interface OutboxJob {
  facilityId: string;
  subjectId: string;
}

/**
 * What a handler reports. `skipped` means it re-read the subject and found
 * nothing left to do (a revoked invitation, a suspended facility), so the job
 * is finished without the call having been made, and nobody is told it was.
 */
export type OutboxOutcome = "done" | "skipped";

export type OutboxHandler = (job: OutboxJob) => Promise<OutboxOutcome>;

const HANDLERS: Record<OutboxOperation, OutboxHandler> = {
  "invitation.send": sendInvitation,
  "mpesa.register_urls": registerUrls,
  "mpesa.stk_push": sendStkPush,
};

/** How long a claimed job stays invisible to other workers. */
const LEASE_SECONDS = 120;
/** After this many attempts a job is failed and left for an operator. */
export const MAX_ATTEMPTS = 5;
/** Retry delay: 30 s, 1, 2, 4 minutes... capped at an hour. */
function backoffSeconds(attempts: number) {
  return Math.min(30 * 2 ** (attempts - 1), 3600);
}

interface ClaimedRow {
  id: string;
  facility_id: string;
  operation: OutboxOperation;
  subject_id: string;
  attempts: number;
}

/**
 * Fails a job whose lease ran out on its last attempt (the worker died before
 * it could record anything), rather than claiming it again: otherwise a job
 * that crashes its worker would be retried forever.
 */
async function failAbandoned() {
  const { rows } = await pool.query<FailedRow>(`
    UPDATE outbox
    SET status = 'failed', completed_at = now(),
        last_error = coalesce(last_error, 'Worker stopped during the final attempt')
    WHERE status = 'pending' AND attempts >= $1 AND available_at <= now()
    RETURNING id, facility_id, operation, attempts
  `, [MAX_ATTEMPTS]);
  rows.forEach(reportFailed);
}

interface FailedRow {
  id: string;
  facility_id: string;
  operation: OutboxOperation;
  attempts: number;
}

/**
 * The line an alert matches on (docs/deployment.md): a job that will not be
 * retried. Ids only, never the subject's details (rule 10); the row's
 * `last_error` says why, for whoever re-runs it.
 */
function reportFailed(row: FailedRow) {
  logger.error(
    { outboxId: row.id, facilityId: row.facility_id, operation: row.operation, attempts: row.attempts },
    "outbox job failed permanently",
  );
}

/**
 * Takes the next due job. SKIP LOCKED lets concurrent workers share the queue
 * without taking the same job; pushing `available_at` forward is the lease,
 * so a job whose worker vanished becomes due again.
 *
 * One at a time, so each lease starts when its own handler does. Claiming a
 * batch would start every lease together, and a job waiting behind slow ones
 * could outlive its lease and be claimed by a second worker too.
 */
async function claimOne(): Promise<ClaimedRow | undefined> {
  const { rows } = await pool.query<ClaimedRow>(`
    UPDATE outbox
    SET attempts = attempts + 1,
        available_at = now() + make_interval(secs => $1)
    WHERE id = (
      SELECT id FROM outbox
      WHERE status = 'pending' AND available_at <= now() AND attempts < $2
      ORDER BY available_at, id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, facility_id, operation, subject_id, attempts
  `, [LEASE_SECONDS, MAX_ATTEMPTS]);
  return rows[0];
}

/** Unconditional: a job that was delivered ends finished, whatever else ran. */
async function recordSuccess(id: string, outcome: OutboxOutcome) {
  await pool.query(
    "UPDATE outbox SET status = $2, completed_at = now(), last_error = NULL WHERE id = $1",
    [id, outcome],
  );
}

/**
 * Only while still pending: a handler that outlived its lease must not turn a
 * job another worker has since finished back into a failure.
 */
async function recordFailure(row: ClaimedRow, err: unknown) {
  // Class, SQLSTATE and the message's first line only: a query error's
  // parameters (an email, later a patient's details) never reach the column.
  const message = errorLine(err);

  if (row.attempts >= MAX_ATTEMPTS) {
    const { rowCount } = await pool.query(
      "UPDATE outbox SET status = 'failed', completed_at = now(), last_error = $2 WHERE id = $1 AND status = 'pending'",
      [row.id, message],
    );
    if (rowCount)
      reportFailed(row);
    return "failed" as const;
  }

  await pool.query(
    "UPDATE outbox SET available_at = now() + make_interval(secs => $2), last_error = $3 WHERE id = $1 AND status = 'pending'",
    [row.id, backoffSeconds(row.attempts), message],
  );
  return "retried" as const;
}

/**
 * One pass over the queue: up to `limit` jobs. `handlers` overrides the real
 * ones, so a test can make a call fail without reaching a provider.
 */
export async function drainOutbox(options: {
  limit?: number;
  handlers?: Partial<Record<OutboxOperation, OutboxHandler>>;
} = {}): Promise<{ done: number; skipped: number; retried: number; failed: number }> {
  const handlers = { ...HANDLERS, ...options.handlers };
  const tally = { done: 0, skipped: 0, retried: 0, failed: 0 };

  await failAbandoned();

  for (let taken = 0; taken < (options.limit ?? 50); taken += 1) {
    const row = await claimOne();
    if (!row)
      break;

    try {
      const outcome = await handlers[row.operation]({ facilityId: row.facility_id, subjectId: row.subject_id });
      await recordSuccess(row.id, outcome);
      tally[outcome] += 1;
    }
    catch (err) {
      tally[await recordFailure(row, err)] += 1;
    }
  }

  return tally;
}
