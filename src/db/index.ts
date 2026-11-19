import type { PoolClient } from "pg";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import type { ErrorSummary } from "@/lib/error-summary";

import env from "@/env";
import { summarizeError } from "@/lib/error-summary";
import { logger } from "@/lib/logger";

import * as authSchema from "./auth-schema";
import { CONNECTION_TIMEOUT_MS, effectiveHost, sslConfigFor } from "./connection";
// schema.ts re-exports the Better-Auth-owned tables, so this is the whole model.
import * as schema from "./schema";

/**
 * Three connections, deliberately (CLAUDE.md §4, layer 1).
 *
 * `db` connects as the OWNER of the tables. With FORCE ROW LEVEL SECURITY the
 * owner role must be a superuser or hold BYPASSRLS to keep its reach, so this
 * connection sees every facility's rows. That is right for migrations, the
 * test harness, tenant bootstrap and the superadmin plane, and wrong for
 * anything else. `db-access.test.ts` keeps it to an allowlist.
 *
 * `appDb` connects as `hospital_app` (db/roles.sql): not the owner, not a
 * superuser, so the policies apply. Every tenant request goes through it,
 * inside a transaction that has set `app.facility_id` (middlewares/tenant.ts).
 * Of identity it sees only `user (id, name, email)`.
 *
 * `authDb` connects as `hospital_auth`, for Better Auth alone: the only role
 * that can read sessions, password hashes and verification tokens, and one
 * that holds nothing on the tenant tables.
 */

/**
 * Keeps an idle-client failure from killing the process. An `error` event with
 * no listener is an unhandled exception in Node, so without this a routine
 * Postgres restart would take the API down.
 */
function surviveIdleFailures(pool: Pool, name: string) {
  pool.on("error", (err) => {
    console.error(`[db:${name}] idle client error:`, err.message);
  });
  return pool;
}

function poolFor(connectionString: string, name: string, max?: number) {
  return surviveIdleFailures(new Pool({
    connectionString,
    ssl: sslConfigFor(connectionString),
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    ...(max === undefined ? {} : { max }),
  }), name);
}

export const pool = poolFor(env.DATABASE_URL, "owner");

/**
 * The host each connection reaches, as pg reads its string: for the
 * development seed, which refuses to write anywhere but this machine.
 */
export const connectionHosts = {
  owner: effectiveHost(env.DATABASE_URL),
  app: effectiveHost(env.APP_DATABASE_URL),
  auth: effectiveHost(env.AUTH_DATABASE_URL),
};

const db = drizzle({
  client: pool,
  casing: "snake_case",
  schema,
});

export const appPool = poolFor(env.APP_DATABASE_URL, "app");

export const appDb = drizzle({
  client: appPool,
  casing: "snake_case",
  schema,
});

export const authPool = poolFor(env.AUTH_DATABASE_URL, "auth");

export const authDb = drizzle({
  client: authPool,
  casing: "snake_case",
  schema: authSchema,
});

/**
 * A few connections as `hospital_auth`, for advisory locks alone
 * (`withAdvisoryLock`). Apart from `authPool`: a request holding a lock keeps
 * its connection for as long as it runs, and must never be what leaves Better
 * Auth's own queries without one. Not exported, and it hands no connection
 * out, so nothing reaches the auth tables through it.
 */
const lockPool = poolFor(env.AUTH_DATABASE_URL, "auth-locks", 10);

const asError = (err: unknown) => (err instanceof Error ? err : new Error(String(err)));

/**
 * Runs `run` holding the advisory lock named `key`, or answers
 * `{ held: false }` at once when another request holds it. Nobody waits, so
 * nothing queues behind a lock, and a burst of requests for one lock holds
 * no connection for longer than it takes to be told no.
 *
 * The lock belongs to its connection's session. A connection that fails, or
 * cannot be unlocked, is closed rather than pooled, which ends the session
 * and frees the lock; the failure is logged. The pool does not watch a
 * client it has handed out, so this one listens for its `error` event
 * itself: unheard, it would be an unhandled exception, and end the process.
 */
export async function withAdvisoryLock<T>(key: string, run: () => Promise<T>): Promise<{ held: true; value: T } | { held: false }> {
  const client = await lockPool.connect();
  let failure: Error | undefined;
  const onError = (err: Error) => {
    failure ??= err;
    logger.error({ error: summarizeError(err) }, "An advisory lock's connection failed");
  };
  const query = async (sql: string) => {
    try {
      return await client.query<{ held: boolean }>(sql, [key]);
    }
    catch (err) {
      failure ??= asError(err);
      throw err;
    }
  };
  client.on("error", onError);
  try {
    const { rows } = await query("SELECT pg_try_advisory_lock(hashtext($1)) AS held");
    if (!rows[0].held)
      return { held: false };
    try {
      return { held: true, value: await run() };
    }
    finally {
      await query("SELECT pg_advisory_unlock(hashtext($1))").catch((err: unknown) => {
        logger.error({ error: summarizeError(err) }, "Could not release an advisory lock: its connection is closed instead");
      });
    }
  }
  finally {
    client.removeListener("error", onError);
    client.release(failure);
  }
}

/** A tenant-scoped handle: the transaction `withFacility` opened, never the pool. */
export type AppDb = Parameters<Parameters<typeof appDb.transaction>[0]>[0];

/** A restricted connection's role could ignore its limits, so serving would be unsafe. */
export class PrivilegedRoleError extends Error {
  constructor(role: string) {
    super(
      `A restricted connection connects as '${role}', which is a superuser or `
      + "holds BYPASSRLS, so the limits on it would not apply. The API will not "
      + "serve. Connect as the unprivileged roles from db/roles.sql.",
    );
    this.name = "PrivilegedRoleError";
  }
}

/**
 * Proves that `target` connects as a role that is neither superuser nor
 * BYPASSRLS.
 *
 * env.ts only compares the DSNs' usernames, so different privileged roles
 * would pass it, and db/roles.sql skips a role that already exists rather
 * than re-asserting its attributes. This asks the database itself.
 */
export async function assertRoleIsRestricted(target: Pool): Promise<void> {
  const { rows } = await target.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  const role = rows[0];
  if (!role || role.rolsuper || role.rolbypassrls)
    throw new PrivilegedRoleError(role?.rolname ?? "unknown");
}

/** How long one connection's probe may take, every step included. */
export const PROBE_DEADLINE_MS = 3000;

/**
 * Probes one connection: null if it can run a query, else why not.
 *
 * Bounded on every step by a deadline here, not only by Postgres: a stalled
 * server would otherwise leave `BEGIN`, or the wait for a connection, without
 * any bound, and the readiness probe hanging with a client held. A client
 * that failed or overran is released with its error, so pg discards it rather
 * than pooling a connection left mid-transaction. Postgres still caps the
 * query itself (`statement_timeout`).
 */
export async function probeConnection(target: Pool, deadlineMs = PROBE_DEADLINE_MS): Promise<ErrorSummary | null> {
  let client: PoolClient | undefined;
  let released = false;
  let timedOut = false;
  const discard = (err: Error) => {
    if (client && !released) {
      released = true;
      client.release(err);
    }
  };

  const work = (async () => {
    client = await target.connect();
    // Arrived after the deadline, unused and healthy: back to the pool as it is, not destroyed.
    if (timedOut) {
      released = true;
      client.release();
      return;
    }
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = 2000");
    await client.query("SELECT 1");
    await client.query("COMMIT");
    if (!released) {
      released = true;
      client.release();
    }
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`No answer within ${deadlineMs} ms`));
    }, deadlineMs);
  });

  try {
    await Promise.race([work, deadline]);
    return null;
  }
  catch (err) {
    discard(err instanceof Error ? err : new Error(String(err)));
    // It settles later, if at all; its client is already discarded.
    work.catch(() => {});
    return summarizeError(err);
  }
  finally {
    clearTimeout(timer);
  }
}

export interface ConnectionCheck {
  owner: boolean;
  app: boolean;
  auth: boolean;
  /** Why each failed connection failed: enough to tell bad credentials from a network fault, nothing about a patient. */
  errors: Partial<Record<"owner" | "app" | "auth", ErrorSummary>>;
}

/**
 * Whether every connection can run a query: the readiness probe.
 *
 * All three, because each logs in as its own role: the owner can still be up
 * while `hospital_app` or `hospital_auth` cannot sign in, and then nothing a
 * user does would work.
 */
export async function checkConnections(): Promise<ConnectionCheck> {
  const [owner, app, auth] = await Promise.all([pool, appPool, authPool].map(target => probeConnection(target)));
  const errors: ConnectionCheck["errors"] = {};
  if (owner)
    errors.owner = owner;
  if (app)
    errors.app = app;
  if (auth)
    errors.auth = auth;
  return { owner: !owner, app: !app, auth: !auth, errors };
}

/** The boot check: both restricted connections really are restricted. */
export async function assertConnectionsAreRestricted(): Promise<void> {
  await assertRoleIsRestricted(appPool);
  await assertRoleIsRestricted(authPool);
}

export default db;
