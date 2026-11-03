import { pinoLogger as logger } from "hono-pino";
import pino from "pino";
import pretty from "pino-pretty";

import env from "@/env";

/**
 * Headers that carry credentials, removed before a line is written.
 *
 * Rule 10 keeps patient data out of logs by never putting it in a URL, a key
 * or a payload; this covers what a request carries regardless. Paths that are
 * absent on a given line cost nothing.
 */
export const REDACTED_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  "res.headers[\"set-cookie\"]",
];

export function pinoLogger() {
  return logger({
    pino: pino({
      level: env.LOG_LEVEL || "info",
      redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
    }, env.NODE_ENV === "production" ? undefined : pretty()),
  });
}
