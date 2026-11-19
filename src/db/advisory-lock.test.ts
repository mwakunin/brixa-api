import { afterEach, describe, expect, it, vi } from "vitest";

import { pool, withAdvisoryLock } from "@/db";
import { logger } from "@/lib/logger";

/**
 * `withAdvisoryLock` (db/index.ts): one holder at a time, nobody waiting, and
 * a lock that goes with its connection when the connection fails.
 */
describe("an advisory lock", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is held by one request at a time, refused at once to another, and free once done", async () => {
    let inner: unknown;
    const outer = await withAdvisoryLock("test:one-at-a-time", async () => {
      inner = await withAdvisoryLock("test:one-at-a-time", async () => "second");
      return "first";
    });

    expect(outer).toEqual({ held: true, value: "first" });
    expect(inner).toEqual({ held: false });
    expect(await withAdvisoryLock("test:one-at-a-time", async () => "again")).toEqual({ held: true, value: "again" });
  });

  /*
   * A connection the database drops while the lock is held emits `error` on
   * a client the pool is not watching: unheard, that is an unhandled
   * exception. It is heard and logged, the connection is closed rather than
   * pooled, and the lock, which lived in its session, is free again.
   */
  it("survives its connection failing while held, and the lock goes with the connection", async () => {
    const logged = vi.spyOn(logger, "error").mockImplementation(() => {});

    const outcome = await withAdvisoryLock("test:connection-lost", async () => {
      // This lock and no other: in this database, under this key (a bigint lock's two halves, put back together).
      const { rows } = await pool.query<{ pid: number }>(`
        SELECT pid FROM pg_locks
        WHERE locktype = 'advisory' AND granted AND objsubid = 1
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND ((classid::bigint << 32) | objid::bigint) = hashtext($1)::bigint
      `, ["test:connection-lost"]);
      expect(rows).toHaveLength(1);
      await pool.query("SELECT pg_terminate_backend($1)", [rows[0].pid]);
      // Until the client hears of it.
      for (let i = 0; i < 100 && logged.mock.calls.length === 0; i += 1)
        await new Promise(resolve => setTimeout(resolve, 20));
      return "done";
    });

    expect(outcome).toEqual({ held: true, value: "done" });
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(Object) }), "An advisory lock's connection failed");
    expect(await withAdvisoryLock("test:connection-lost", async () => "free")).toEqual({ held: true, value: "free" });
  });
});
