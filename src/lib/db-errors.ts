/**
 * Postgres SQLSTATE codes we translate into HTTP responses.
 *
 * @see https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
export const PG_ERRORS = {
  /** A CHECK constraint rejected the row. */
  CHECK_VIOLATION: "23514",
  /** An EXCLUDE constraint rejected the row — e.g. overlapping date ranges. */
  EXCLUSION_VIOLATION: "23P01",
  /** A UNIQUE constraint rejected the row. */
  UNIQUE_VIOLATION: "23505",
  /** A foreign key was missing or still referenced. */
  FOREIGN_KEY_VIOLATION: "23503",
} as const;

interface PgErrorLike {
  code?: unknown;
  constraint?: unknown;
  cause?: unknown;
}

/**
 * Drizzle wraps driver errors in a `DrizzleQueryError` and hangs the original
 * pg error off `.cause`, so the SQLSTATE is never on the top-level object.
 * Walk the chain rather than checking one level.
 */
function findPgError(err: unknown): PgErrorLike | undefined {
  let current = err;

  for (let depth = 0; current != null && depth < 5; depth += 1) {
    // A STRING `code`, not merely the presence of one. Node attaches numeric
    // and symbolic `code` values to plenty of errors (`ECONNREFUSED`, an
    // AggregateError), and stopping at the first object that happens to have
    // the property would return a wrapper whose SQLSTATE is undefined — while
    // the real pg error sat one link further down the chain.
    if (typeof current === "object" && typeof (current as PgErrorLike).code === "string")
      return current as PgErrorLike;

    current = (current as PgErrorLike).cause;
  }

  return undefined;
}

/** The SQLSTATE of a database error, wherever drizzle buried it. */
export function pgErrorCode(err: unknown): string | undefined {
  const found = findPgError(err);
  return typeof found?.code === "string" ? found.code : undefined;
}

/** The name of the constraint that rejected the row, when the driver reports it. */
export function pgConstraintName(err: unknown): string | undefined {
  const found = findPgError(err);
  return typeof found?.constraint === "string" ? found.constraint : undefined;
}

export function isExclusionViolation(err: unknown): boolean {
  return pgErrorCode(err) === PG_ERRORS.EXCLUSION_VIOLATION;
}

export function isCheckViolation(err: unknown): boolean {
  return pgErrorCode(err) === PG_ERRORS.CHECK_VIOLATION;
}

export function isForeignKeyViolation(err: unknown): boolean {
  return pgErrorCode(err) === PG_ERRORS.FOREIGN_KEY_VIOLATION;
}

export function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === PG_ERRORS.UNIQUE_VIOLATION;
}
