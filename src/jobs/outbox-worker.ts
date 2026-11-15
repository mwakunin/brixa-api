import type { OutboxOperation } from "@/lib/outbox";

import { pool } from "@/db";
import { abandonAppointmentReminder, sendAppointmentReminder } from "@/lib/appointment-reminders";
import { errorLine } from "@/lib/error-summary";
import { sendInvitation } from "@/lib/invitations";
import { logger } from "@/lib/logger";
import { registerUrls } from "@/lib/mpesa";
import { closeAbandonedStkPush, sendStkPush } from "@/lib/mpesa-stk";

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
 * Each claim takes a fresh token, and only the attempt holding the current
 * one records an outcome. An attempt that outlived its lease, while a later
 * attempt holds the job, is superseded: it records nothing, so it can neither
 * finish the job under the later attempt nor move its lease.
 *
 * Triggered by a Cloud Task after each commit that queues a job, and by a
 * Scheduler sweep, both through `POST /internal/outbox/drain`
 * (routes/internal.route.ts). In development it runs in-process after the
 * commit; `pnpm outbox:drain` runs it by hand.
 */

export interface OutboxJob {
  facilityId: string;
  subjectId: string;
  /** No retry follows this attempt: a handler that would ask for one must settle the subject instead. */
  finalAttempt?: boolean;
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
  "appointment.remind": job => sendAppointmentReminder(job),
};

/**
 * What a job leaves to put right once it will not be retried, where its
 * subject would otherwise be stuck mid-way (a prompt `sending` for ever).
 * Run after the job is marked failed; must be safe to run twice.
 */
const ON_GIVE_UP: Partial<Record<OutboxOperation, (job: OutboxJob) => Promise<void>>> = {
  "mpesa.stk_push": closeAbandonedStkPush,
  "appointment.remind": abandonAppointmentReminder,
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
  claim_token: string;
}

type Outcome = OutboxOutcome | "retried" | "failed" | "superseded";

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
    RETURNING id, facility_id, operation, subject_id, attempts
  `, [MAX_ATTEMPTS]);
  for (const row of rows)
    await gaveUp(row);
}

interface FailedRow {
  id: string;
  facility_id: string;
  operation: OutboxOperation;
  subject_id: string;
  attempts: number;
}

/**
 * Reports a job that will not be retried, then lets its operation put its
 * subject right. That step failing is logged, never thrown: the job is
 * already failed, and the alert below has fired.
 */
async function gaveUp(row: FailedRow) {
  reportFailed(row);
  try {
    await ON_GIVE_UP[row.operation]?.({ facilityId: row.facility_id, subjectId: row.subject_id });
  }
  catch (err) {
    logger.error({ outboxId: row.id, facilityId: row.facility_id, operation: row.operation, error: errorLine(err) }, "could not settle a failed outbox job's subject");
  }
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
        available_at = now() + make_interval(secs => $1),
        claim_token = gen_random_uuid()
    WHERE id = (
      SELECT id FROM outbox
      WHERE status = 'pending' AND available_at <= now() AND attempts < $2
      ORDER BY available_at, id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, facility_id, operation, subject_id, attempts, claim_token
  `, [LEASE_SECONDS, MAX_ATTEMPTS]);
  return rows[0];
}

/**
 * Every outcome is written only by the attempt holding the current claim, and
 * only while the job is pending. A later claim has replaced the token of an
 * attempt that outlived its lease, and a job already finished is not pending:
 * either way the write matches nothing.
 */
const HELD = "id = $1 AND claim_token = $2 AND status = 'pending'";

/**
 * An attempt that no longer holds its job. Ids only (rule 10); seen often, it
 * means calls are outliving `LEASE_SECONDS`.
 */
function superseded(row: ClaimedRow): "superseded" {
  logger.warn(
    { outboxId: row.id, facilityId: row.facility_id, operation: row.operation, attempts: row.attempts },
    "outbox attempt outlived its lease",
  );
  return "superseded";
}

async function recordSuccess(row: ClaimedRow, outcome: OutboxOutcome): Promise<Outcome> {
  const { rowCount } = await pool.query(
    `UPDATE outbox SET status = $3, completed_at = now(), last_error = NULL WHERE ${HELD}`,
    [row.id, row.claim_token, outcome],
  );
  return rowCount ? outcome : superseded(row);
}

async function recordFailure(row: ClaimedRow, err: unknown): Promise<Outcome> {
  // Class, SQLSTATE and the message's first line only: a query error's
  // parameters (an email, later a patient's details) never reach the column.
  const message = errorLine(err);

  if (row.attempts >= MAX_ATTEMPTS) {
    const { rowCount } = await pool.query(
      `UPDATE outbox SET status = 'failed', completed_at = now(), last_error = $3 WHERE ${HELD}`,
      [row.id, row.claim_token, message],
    );
    if (!rowCount)
      return superseded(row);
    await gaveUp(row);
    return "failed";
  }

  const { rowCount } = await pool.query(
    `UPDATE outbox SET available_at = now() + make_interval(secs => $3), last_error = $4 WHERE ${HELD}`,
    [row.id, row.claim_token, backoffSeconds(row.attempts), message],
  );
  return rowCount ? "retried" : superseded(row);
}

/**
 * One pass over the queue: up to `limit` jobs. `handlers` overrides the real
 * ones, so a test can make a call fail without reaching a provider.
 */
export async function drainOutbox(options: {
  limit?: number;
  handlers?: Partial<Record<OutboxOperation, OutboxHandler>>;
} = {}): Promise<Record<Outcome, number>> {
  const handlers = { ...HANDLERS, ...options.handlers };
  const tally: Record<Outcome, number> = { done: 0, skipped: 0, retried: 0, failed: 0, superseded: 0 };

  await failAbandoned();

  for (let taken = 0; taken < (options.limit ?? 50); taken += 1) {
    const row = await claimOne();
    if (!row)
      break;

    try {
      const outcome = await handlers[row.operation]({ facilityId: row.facility_id, subjectId: row.subject_id, finalAttempt: row.attempts >= MAX_ATTEMPTS });
      tally[await recordSuccess(row, outcome)] += 1;
    }
    catch (err) {
      tally[await recordFailure(row, err)] += 1;
    }
  }

  return tally;
}
