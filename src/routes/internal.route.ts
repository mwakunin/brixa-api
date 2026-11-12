import { createMiddleware } from "hono/factory";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { InvokerVerifier } from "@/lib/invoker-auth";
import type { AppBindings, AppOpenAPI } from "@/lib/types";

import env from "@/env";
import { accrueAllBedDays } from "@/jobs/bed-days";
import { drainOutbox } from "@/jobs/outbox-worker";
import { reconcileAll } from "@/jobs/reconciliation";
import { closeFinishedVisits, closeStaleVisits } from "@/jobs/visits";
import { DRAIN_PATH, INVOKER_AUDIENCE } from "@/lib/cloud-tasks";
import { createRouter } from "@/lib/create-app";
import { googleInvokerVerifier } from "@/lib/invoker-auth";

/**
 * Routes only Cloud Tasks and Cloud Scheduler call (CLAUDE.md §7), each with
 * a Google-signed identity token (lib/invoker-auth.ts). Left out of the
 * OpenAPI document: they are not part of the API anyone builds against.
 *
 *   POST /internal/outbox/drain   one pass over the outbox. A Cloud Task
 *                                 after each commit that queues a job, and a
 *                                 Scheduler sweep every minute for retries
 *                                 and anything a nudge missed.
 *
 *   POST /internal/jobs/bed-days  charges every open admission's nights so
 *                                 far. Cloud Scheduler, shortly after
 *                                 midnight in Nairobi.
 *
 *   POST /internal/jobs/close-visits  closes outpatient visits still open
 *                                 after their day. Cloud Scheduler, early
 *                                 each morning in Nairobi.
 *
 *   POST /internal/jobs/finish-visits  closes outpatient visits with nothing
 *                                 pending. Cloud Scheduler, every 15 minutes.
 *
 * Delivery is at least once and both are idempotent, so a duplicate
 * call does nothing harmful. A 500 makes Cloud Tasks retry; a job that
 * failed is already recorded for backoff, so the drain still answers 200.
 */
/** The nightly bed-day run. */
export const BED_DAYS_PATH = "/internal/jobs/bed-days";
export const RECONCILIATION_PATH = "/internal/jobs/reconciliation";
/** The nightly close of outpatient visits left open. */
export const CLOSE_VISITS_PATH = "/internal/jobs/close-visits";
/** The check every 15 minutes that closes outpatient visits with nothing pending. */
export const FINISH_VISITS_PATH = "/internal/jobs/finish-visits";

export function createInternalRouter(verifier: InvokerVerifier): AppOpenAPI {
  const router = createRouter();

  router.use("/internal/*", createMiddleware<AppBindings>(async (c, next) => {
    if (!(await verifier.verify(c.req.header("authorization")))) {
      c.var.logger.warn("internal route refused: no valid invoker token");
      return c.json({ message: HttpStatusPhrases.UNAUTHORIZED }, HttpStatusCodes.UNAUTHORIZED);
    }
    await next();
  }));

  router.post(DRAIN_PATH, async c => c.json(await drainOutbox(), HttpStatusCodes.OK));
  router.post(BED_DAYS_PATH, async c => c.json(await accrueAllBedDays(), HttpStatusCodes.OK));
  router.post(RECONCILIATION_PATH, async c => c.json(await reconcileAll(), HttpStatusCodes.OK));
  router.post(CLOSE_VISITS_PATH, async c => c.json(await closeStaleVisits(), HttpStatusCodes.OK));
  router.post(FINISH_VISITS_PATH, async c => c.json(await closeFinishedVisits(), HttpStatusCodes.OK));

  return router;
}

export default createInternalRouter(googleInvokerVerifier({
  audience: INVOKER_AUDIENCE,
  allowedEmails: new Set(env.TASKS_INVOKER_EMAIL ? [env.TASKS_INVOKER_EMAIL] : []),
}));
