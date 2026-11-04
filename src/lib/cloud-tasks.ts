import { GoogleAuth } from "google-auth-library";

import env from "@/env";

/**
 * Creating Cloud Tasks (CLAUDE.md §7), through the REST API rather than the
 * gRPC client library: one call does not justify gRPC's weight in the image
 * or on a cold start.
 *
 * A task carries no payload, only a deterministic name, so delivering it
 * twice does no harm and creating it twice is refused by Cloud Tasks itself.
 * The worker it reaches re-reads the queue (rule 10, rule 18).
 */

/** The internal route a drain task calls. */
export const DRAIN_PATH = "/internal/outbox/drain";

/**
 * The audience identity tokens are minted for and checked against: the API's
 * own origin, which is also where the tasks are sent.
 */
export const INVOKER_AUDIENCE = new URL(env.BETTER_AUTH_URL).origin;

/** What creating a task needs from an HTTP client; `GoogleAuth` provides it. */
export interface TasksClient {
  request: (options: { url: string; method: "POST"; data: unknown }) => Promise<unknown>;
}

const googleAuth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });

/** The task that drains the outbox for one queued job. */
export function drainTask(queue: string, outboxId: string, invokerEmail: string) {
  return {
    url: `https://cloudtasks.googleapis.com/v2/${queue}/tasks`,
    data: {
      task: {
        // One task per job: a second create for the same job is refused.
        name: `${queue}/tasks/outbox-${outboxId}`,
        httpRequest: {
          url: `${INVOKER_AUDIENCE}${DRAIN_PATH}`,
          httpMethod: "POST",
          oidcToken: { serviceAccountEmail: invokerEmail, audience: INVOKER_AUDIENCE },
        },
      },
    },
  };
}

function statusOf(err: unknown): number | undefined {
  const e = err as { status?: number; response?: { status?: number } };
  return e.response?.status ?? e.status;
}

/** Asks Cloud Tasks to drain the outbox now. A task already made for this job is success. */
export async function createDrainTask(
  outboxId: string,
  options: { queue: string; invokerEmail: string; client?: TasksClient },
): Promise<void> {
  const { url, data } = drainTask(options.queue, outboxId, options.invokerEmail);
  try {
    await (options.client ?? googleAuth).request({ url, method: "POST", data });
  }
  catch (err) {
    if (statusOf(err) === 409)
      return;
    throw err;
  }
}
