/**
 * Connection settings shared by the runtime pool and the deploy-time migrator.
 *
 * This lives in its own module, free of side effects, because `db/index.ts`
 * builds a Pool at import time — the migrator makes its own and must not
 * create a second. Having one implementation is the point: this logic was
 * previously duplicated, and the copy silently kept an older, broken version.
 */

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

/** TLS settings for a `pg` Pool built from this DSN. */
export function sslConfigFor(connectionString: string) {
  return isLocalDatabase(connectionString)
    ? false as const
    : { rejectUnauthorized: true };
}
