import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { pool } from "@/db";
import { runAsFacility } from "@/db/tenant-transaction";
import { pgErrorCode } from "@/lib/db-errors";
import { enqueue } from "@/lib/outbox";
import { makeFacility, resetDb } from "@/test/helpers";

import type { OutboxHandler, OutboxJob } from "./outbox-worker";

import { drainOutbox, MAX_ATTEMPTS } from "./outbox-worker";

async function queued(facilityId: string, subjectId = randomUUID()) {
  await runAsFacility(facilityId, tx => enqueue(tx, { facilityId, operation: "invitation.send", subjectId }));
  return subjectId;
}

async function job(subjectId: string) {
  const { rows } = await pool.query<{
    status: string;
    attempts: number;
    last_error: string | null;
    due_in_seconds: number;
  }>(`
    SELECT status, attempts, last_error,
           EXTRACT(EPOCH FROM available_at - now())::int AS due_in_seconds
    FROM outbox WHERE subject_id = $1
  `, [subjectId]);
  return rows[0];
}

/** Makes a claimed-and-backed-off job due again, as time passing would. */
async function makeDue(subjectId: string) {
  await pool.query("UPDATE outbox SET available_at = now() WHERE subject_id = $1", [subjectId]);
}

function handling(handler: OutboxHandler) {
  return { handlers: { "invitation.send": handler } };
}

const succeed: OutboxHandler = async () => "done";

function failWith(message: string): OutboxHandler {
  return async () => {
    throw new Error(message);
  };
}

const NOTHING = { done: 0, skipped: 0, retried: 0, failed: 0, superseded: 0 };

/** A handler that waits to be let go, then answers as `then` does. */
function heldOpen(then: OutboxHandler) {
  let started!: () => void;
  let release!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler: OutboxHandler = async (j) => {
    started();
    await released;
    return then(j);
  };
  return { handler, running, release };
}

describe("the outbox worker", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("hands a due job to its handler with ids only, then records it done", async () => {
    const facility = await makeFacility();
    const subjectId = await queued(facility.id);
    const seen: OutboxJob[] = [];

    const tally = await drainOutbox(handling(async (j) => {
      seen.push(j);
      return "done";
    }));

    expect(tally).toEqual({ ...NOTHING, done: 1 });
    // Ids, and whether this is the last try: nothing about the subject itself.
    expect(seen).toEqual([{ facilityId: facility.id, subjectId, finalAttempt: false }]);
    expect(await job(subjectId)).toMatchObject({ status: "done", attempts: 1, last_error: null });
  });

  it("records a job its handler found nothing to do for as skipped, not done", async () => {
    const facility = await makeFacility();
    const subjectId = await queued(facility.id);

    const tally = await drainOutbox(handling(async () => "skipped"));

    expect(tally).toEqual({ ...NOTHING, skipped: 1 });
    expect(await job(subjectId)).toMatchObject({ status: "skipped" });
  });

  it("backs a failed call off and tries again later", async () => {
    const facility = await makeFacility();
    const subjectId = await queued(facility.id);

    const tally = await drainOutbox(handling(failWith("provider timed out")));

    expect(tally).toEqual({ ...NOTHING, retried: 1 });
    const after = await job(subjectId);
    expect(after).toMatchObject({ status: "pending", attempts: 1, last_error: "Error | provider timed out" });
    expect(after.due_in_seconds).toBeGreaterThan(0);

    // Not due yet, so another pass leaves it alone.
    expect(await drainOutbox(handling(succeed))).toEqual(NOTHING);
  });

  it("gives up after its last attempt and leaves the job for an operator", async () => {
    const facility = await makeFacility();
    const subjectId = await queued(facility.id);

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      await drainOutbox(handling(failWith("rejected")));
      await makeDue(subjectId);
    }
    const last = await drainOutbox(handling(failWith("rejected")));

    expect(last).toEqual({ ...NOTHING, failed: 1 });
    expect(await job(subjectId)).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
  });

  it("fails a job whose worker died during its final attempt, rather than retrying it forever", async () => {
    const facility = await makeFacility();
    const subjectId = await queued(facility.id);
    // As a crash leaves it: the last attempt claimed, its lease run out, no outcome recorded.
    await pool.query(
      "UPDATE outbox SET attempts = $1, available_at = now() - interval '1 second' WHERE subject_id = $2",
      [MAX_ATTEMPTS, subjectId],
    );
    let calls = 0;

    await drainOutbox(handling(async () => {
      calls += 1;
      return "done";
    }));

    expect(calls).toBe(0);
    expect(await job(subjectId)).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
  });

  it("never turns a job another worker finished back into a failure", async () => {
    const facility = await makeFacility();
    const subjectId = await queued(facility.id);

    // This handler outlives its lease: meanwhile another worker delivers the
    // job and records it done. Then this one fails.
    await drainOutbox(handling(async () => {
      await pool.query("UPDATE outbox SET status = 'done', completed_at = now() WHERE subject_id = $1", [subjectId]);
      throw new Error("slow worker gave up");
    }));

    expect(await job(subjectId)).toMatchObject({ status: "done", last_error: null });
  });

  it("lets an attempt that outlived its lease record nothing, so the later attempt's failure is retried", async () => {
    const facility = await makeFacility();
    const subjectId = await queued(facility.id);
    const first = heldOpen(succeed);

    // The first attempt is slow, and its lease runs out while it waits...
    const slow = drainOutbox(handling(first.handler));
    await first.running;
    await makeDue(subjectId);
    // ...so a second worker claims the job, and that call fails.
    expect(await drainOutbox(handling(failWith("provider down")))).toEqual({ ...NOTHING, retried: 1 });

    // The first then succeeds, but no longer holds the job: marking it done
    // would cancel the retry the second attempt just scheduled.
    first.release();
    expect(await slow).toEqual({ ...NOTHING, superseded: 1 });
    const after = await job(subjectId);
    expect(after).toMatchObject({ status: "pending", attempts: 2, last_error: "Error | provider down" });
    expect(after.due_in_seconds).toBeGreaterThan(0);
  });

  it("keeps an attempt that outlived its lease from moving the lease of the attempt holding the job", async () => {
    const facility = await makeFacility();
    const subjectId = await queued(facility.id);
    const first = heldOpen(failWith("slow worker gave up"));
    const second = heldOpen(succeed);

    const slow = drainOutbox(handling(first.handler));
    await first.running;
    await makeDue(subjectId);
    const current = drainOutbox(handling(second.handler));
    await second.running;

    // A retry written now would make the job due in 30 s, inside the second
    // attempt's 120 s lease, for a third worker to claim alongside it.
    first.release();
    expect(await slow).toEqual({ ...NOTHING, superseded: 1 });
    const during = await job(subjectId);
    expect(during).toMatchObject({ status: "pending", attempts: 2, last_error: null });
    expect(during.due_in_seconds).toBeGreaterThan(60);

    second.release();
    expect(await current).toEqual({ ...NOTHING, done: 1 });
    expect(await job(subjectId)).toMatchObject({ status: "done", attempts: 2 });
  });

  it("records what failed without any of the query's values", async () => {
    const facility = await makeFacility();
    const subjectId = await queued(facility.id);

    await drainOutbox(handling(failWith("Failed query: select 1\nparams: someone@example.test")));

    const { last_error } = await job(subjectId);
    expect(last_error).toContain("Failed query: select 1");
    expect(last_error).not.toContain("someone@example.test");
  });

  it("claims one job at a time, so a job waiting its turn is not yet leased", async () => {
    const facility = await makeFacility();
    const first = await queued(facility.id);
    const second = await queued(facility.id);
    const seenWhileFirstRan: number[] = [];

    await drainOutbox(handling(async (j) => {
      if (j.subjectId === first)
        seenWhileFirstRan.push((await job(second)).attempts);
      return "done";
    }));

    // Had the pass claimed both at once, the second's lease would already be
    // running down while it waited.
    expect(seenWhileFirstRan).toEqual([0]);
    expect(await job(second)).toMatchObject({ status: "done", attempts: 1 });
  });

  it("never gives one job to two workers at once", async () => {
    const facility = await makeFacility();
    await queued(facility.id);
    let calls = 0;

    const slow = handling(async () => {
      calls += 1;
      await new Promise(resolve => setTimeout(resolve, 200));
      return "done";
    });
    const [one, two] = await Promise.all([drainOutbox(slow), drainOutbox(slow)]);

    expect(calls).toBe(1);
    expect(one.done + two.done).toBe(1);
  });

  it("lets a request enqueue but not mark a job done", async () => {
    const facility = await makeFacility();
    const subjectId = await queued(facility.id);

    // A handler that could complete a job could also suppress one.
    const err = await runAsFacility(facility.id, tx => tx.execute(
      sql`UPDATE outbox SET status = 'done' WHERE subject_id = ${subjectId}`,
    )).then(() => null, (e: unknown) => e);

    expect(pgErrorCode(err)).toBe("42501");
  });
});
