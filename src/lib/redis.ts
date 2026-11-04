import { Redis } from "ioredis";

import env from "@/env";

/**
 * Shared Redis connection.
 *
 * Rate limiting is the only user today, which shapes the settings below:
 * Redis being unavailable must never take the API down with it, so the client
 * is configured to fail fast and let callers decide, rather than queueing
 * commands until something times out.
 */
export const redis = new Redis(env.REDIS_URL, {
  // Don't hold requests hostage behind a reconnect; a failed command surfaces
  // immediately and the caller falls back.
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  connectTimeout: 2000,
  // Connects eagerly. `lazyConnect` would defer until the first command — but
  // with the offline queue disabled that command is rejected before the
  // connection finishes, so every process would fail its first rate-limit
  // check. The two options contradict each other.
});

// Without a listener, ioredis treats connection errors as unhandled and can
// take the process down — the opposite of degrading gracefully.
redis.on("error", () => {
  // Deliberately quiet: a down Redis produces an error per command, and the
  // callers that matter already log once with context.
});

export async function closeRedis() {
  await redis.quit().catch(() => redis.disconnect());
}
