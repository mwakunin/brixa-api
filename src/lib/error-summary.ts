import { pgConstraintName, pgErrorCode } from "./db-errors";

/**
 * What may be said about an error outside the database row it concerns: in a
 * log line, an outbox `last_error`, or (never) a response body.
 *
 * Drizzle's messages read `Failed query: <sql>\nparams: <values>`, and a pg
 * error's `detail` repeats the offending values (`Key (email)=(...) already
 * exists`). Those values are emails today and patient data tomorrow, so rule
 * 10 forbids them anywhere but the database. This keeps the error's class,
 * its SQLSTATE and constraint, and the first line of its message with any
 * parameters cut off: enough to diagnose, nothing about a person.
 */
export interface ErrorSummary {
  name: string;
  message: string;
  code?: string;
  constraint?: string;
}

const MESSAGE_LIMIT = 300;

export function summarizeError(err: unknown): ErrorSummary {
  const name = err instanceof Error ? err.name : typeof err;
  const raw = err instanceof Error ? err.message : String(err);
  const message = raw.split(/\n\s*params:/)[0].split("\n")[0].slice(0, MESSAGE_LIMIT);

  const summary: ErrorSummary = { name, message };
  const code = pgErrorCode(err);
  const constraint = pgConstraintName(err);
  if (code)
    summary.code = code;
  if (constraint)
    summary.constraint = constraint;
  return summary;
}

/** One line, for a column like `outbox.last_error`. */
export function errorLine(err: unknown): string {
  const s = summarizeError(err);
  return [s.name, s.code, s.constraint, s.message].filter(Boolean).join(" | ");
}
