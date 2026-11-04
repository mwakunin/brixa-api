import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import env from "@/env";

import * as authSchema from "./auth-schema";
import { CONNECTION_TIMEOUT_MS, sslConfigFor } from "./connection";
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

function poolFor(connectionString: string, name: string) {
  return surviveIdleFailures(new Pool({
    connectionString,
    ssl: sslConfigFor(connectionString),
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  }), name);
}

export const pool = poolFor(env.DATABASE_URL, "owner");

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

/**
 * Whether every connection can run a query: the readiness probe.
 *
 * All three, because each logs in as its own role: the owner can still be up
 * while `hospital_app` or `hospital_auth` cannot sign in, and then nothing a
 * user does would work. Each probe is bounded by Postgres itself
 * (`statement_timeout`) as well as by the pool's connection timeout, so a
 * probe cannot hang.
 */
export async function checkConnections(): Promise<{ owner: boolean; app: boolean; auth: boolean }> {
  async function probe(target: Pool) {
    const client = await target.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = 2000");
      await client.query("SELECT 1");
      await client.query("COMMIT");
      return true;
    }
    catch {
      await client.query("ROLLBACK").catch(() => {});
      return false;
    }
    finally {
      client.release();
    }
  }

  const [owner, app, auth] = await Promise.all(
    [pool, appPool, authPool].map(target => probe(target).catch(() => false)),
  );
  return { owner, app, auth };
}

/** The boot check: both restricted connections really are restricted. */
export async function assertConnectionsAreRestricted(): Promise<void> {
  await assertRoleIsRestricted(appPool);
  await assertRoleIsRestricted(authPool);
}

export default db;
