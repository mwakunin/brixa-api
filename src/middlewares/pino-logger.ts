import type { Context } from "hono";
import type { Logger } from "pino";

import { pinoLogger as requestLogger } from "hono-pino";

import { logger } from "@/lib/logger";

export { REDACTED_PATHS } from "@/lib/logger";

/**
 * The message on a request's log line.
 *
 * Fixed, never the error's own text. hono-pino's default is `c.error.message`
 * on a failed request, and a database error's message is Drizzle's
 * `Failed query: <sql> params: <values>`, so a crash on a write would put
 * whatever the query held, patient data included, in the log (rule 10). What
 * went wrong is logged once, without its parameters, by the error handler
 * (lib/on-error.ts).
 */
export function requestLogMessage(c: Pick<Context, "error">): string {
  return c.error ? "Request failed" : "Request completed";
}

/**
 * A path as it may be logged. An M-Pesa callback's path carries the
 * facility's secret callback token, and anyone holding that token can post
 * payment confirmations, so it is replaced before the line is written.
 */
export function loggedPath(path: string): string {
  return path.replace(/^\/webhooks\/mpesa\/[^/]+/, "/webhooks/mpesa/[token]");
}

/**
 * One line per request, through the process's shared, redacting logger.
 * `target` is a parameter so a test can read what would be written.
 */
export function pinoLogger(target: Logger = logger) {
  return requestLogger({
    pino: target,
    http: {
      onResMessage: requestLogMessage,
      // hono-pino's own bindings, but with the path made safe to log.
      onReqBindings: c => ({ req: { url: loggedPath(c.req.path), method: c.req.method, headers: c.req.header() } }),
    },
  });
}
