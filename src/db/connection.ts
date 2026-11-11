/**
 * Connection settings shared by the runtime pool and the deploy-time migrator.
 *
 * This lives in its own module, free of side effects, because `db/index.ts`
 * builds a Pool at import time — the migrator makes its own and must not
 * create a second. Having one implementation is the point: this logic was
 * previously duplicated, and the copy silently kept an older, broken version.
 */

import { parse } from "pg-connection-string";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Whether the DSN points at a database on this machine, which is the only
 * case where running without TLS is acceptable.
 *
 * Compares the parsed *hostname* rather than searching the whole connection
 * string: a substring test silently disables TLS for a remote host whenever
 * "localhost" appears anywhere else in the URL — in a password, a query
 * parameter, or a hostname like `localhost.example.com`.
 *
 * An unparseable DSN is treated as remote. Failing closed keeps a malformed
 * production URL from quietly downgrading to plaintext.
 */
export function isLocalDatabase(connectionString: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(connectionString).hostname);
  }
  catch {
    return false;
  }
}

/**
 * How long to wait for a connection before giving up. `pg` waits forever by
 * default, which turns a database outage into hung requests (including
 * `/health`), or a migration that never finishes, instead of failed ones.
 */
export const CONNECTION_TIMEOUT_MS = 5_000;

/** A remote connection string whose own SSL parameters would weaken TLS. */
export class InsecureDatabaseUrlError extends Error {
  constructor(weakening: string) {
    // Never the connection string itself: it carries the password.
    super(`A remote database connection string must not ${weakening}. Remove its SSL parameters, or use sslmode=verify-full.`);
    this.name = "InsecureDatabaseUrlError";
  }
}

/**
 * How the DSN's own SSL parameters would weaken TLS, or null if they would not.
 *
 * `pg` lets SSL settings in the connection string replace the `ssl` option a
 * Pool is given, so `?sslmode=disable` or `?sslmode=no-verify` would quietly
 * undo the strict setting `sslConfigFor` returns. Read with pg's own parser,
 * so this judges exactly what pg will do, `uselibpqcompat` included.
 */
function weakeningIn(connectionString: string): string | null {
  const { ssl } = parse(connectionString);

  if (ssl === false)
    return "turn TLS off";
  if (ssl === "no-verify" || (typeof ssl === "object" && ssl.rejectUnauthorized === false))
    return "turn off certificate verification";
  return null;
}

/**
 * TLS settings for a `pg` Pool built from this DSN. Throws
 * `InsecureDatabaseUrlError` for a remote DSN that asks for less than a
 * verified certificate, so a misconfigured deployment fails at startup
 * rather than sending health data in the clear.
 */
export function sslConfigFor(connectionString: string): false | { rejectUnauthorized: true } {
  if (isLocalDatabase(connectionString))
    return false as const;

  const weakening = weakeningIn(connectionString);
  if (weakening)
    throw new InsecureDatabaseUrlError(weakening);

  return { rejectUnauthorized: true };
}
