import type { OutboxOperation } from "@/lib/outbox";

import { pool } from "@/db";
import { errorLine } from "@/lib/error-summary";
import { sendInvitation } from "@/lib/invitations";

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
 * Triggered by Cloud Tasks on write and a Scheduler sweep once those are
 * wired; `pnpm outbox:drain` runs it by hand.
 */

export interface OutboxJob {
  facilityId: string;
  subjectId: string;
}

export type OutboxHandler = (job: OutboxJob) => Promise<void>;

const HANDLERS: Record<OutboxOperation, OutboxHandler> = {
  "invitation.send": sendInvitation,
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
 * Takes up to `limit` due jobs. SKIP LOCKED lets concurrent workers share the
 * queue without taking the same job; pushing `available_at` forward is the
 * lease, so a job whose worker vanished becomes due again.
 *
 * A job whose lease ran out on its last attempt (the worker died before it
 * could record anything) is failed first rather than claimed again: otherwise
 * a job that crashes its worker would be retried forever.
 */
async function claim(limit: number): Promise<ClaimedRow[]> {
  await pool.query(`
    UPDATE outbox
    SET status = 'failed', completed_at = now(),
        last_error = coalesce(last_error, 'Worker stopped during the final attempt')
    WHERE status = 'pending' AND attempts >= $1 AND available_at <= now()
  `, [MAX_ATTEMPTS]);

  const { rows } = await pool.query<ClaimedRow>(`
    UPDATE outbox
    SET attempts = attempts + 1,
        available_at = now() + make_interval(secs => $2)
    WHERE id IN (
      SELECT id FROM outbox
      WHERE status = 'pending' AND available_at <= now() AND attempts < $3
      ORDER BY available_at, id
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, facility_id, operation, subject_id, attempts
  `, [limit, LEASE_SECONDS, MAX_ATTEMPTS]);
  return rows;
}

async function recordSuccess(id: string) {
  await pool.query(
    "UPDATE outbox SET status = 'done', completed_at = now(), last_error = NULL WHERE id = $1",
    [id],
  );
}

async function recordFailure(row: ClaimedRow, err: unknown) {
  // Class, SQLSTATE and the message's first line only: a query error's
  // parameters (an email, later a patient's details) never reach the column.
  const message = errorLine(err);

  if (row.attempts >= MAX_ATTEMPTS) {
    await pool.query(
      "UPDATE outbox SET status = 'failed', completed_at = now(), last_error = $2 WHERE id = $1",
      [row.id, message],
    );
    return "failed" as const;
  }

  await pool.query(
    "UPDATE outbox SET available_at = now() + make_interval(secs => $2), last_error = $3 WHERE id = $1",
    [row.id, backoffSeconds(row.attempts), message],
  );
  return "retried" as const;
}

/**
 * One pass over the queue. `handlers` overrides the real ones, so a test can
 * make a call fail without reaching a provider.
 */
export async function drainOutbox(options: {
  limit?: number;
  handlers?: Partial<Record<OutboxOperation, OutboxHandler>>;
} = {}): Promise<{ done: number; retried: number; failed: number }> {
  const handlers = { ...HANDLERS, ...options.handlers };
  const tally = { done: 0, retried: 0, failed: 0 };

  for (const row of await claim(options.limit ?? 50)) {
    try {
      await handlers[row.operation]({ facilityId: row.facility_id, subjectId: row.subject_id });
      await recordSuccess(row.id);
      tally.done += 1;
    }
    catch (err) {
      tally[await recordFailure(row, err)] += 1;
    }
  }

  return tally;
}
