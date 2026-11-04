import { pinoLogger as requestLogger } from "hono-pino";

import { logger } from "@/lib/logger";

export { REDACTED_PATHS } from "@/lib/logger";

/** One line per request, through the process's shared, redacting logger. */
export function pinoLogger() {
  return requestLogger({ pino: logger });
}
