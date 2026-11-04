/* eslint-disable no-console */
import { drainOutbox } from "@/jobs/outbox-worker";

/**
 * Runs one pass of the outbox worker by hand: `pnpm outbox:drain`.
 *
 * Production drains through Cloud Tasks and Cloud Scheduler, and development
 * drains in-process after each commit (lib/outbox-nudge.ts); this is for a
 * job queued while neither ran, such as one written by a script. Without
 * Resend configured, an email is printed to the console (lib/email.ts).
 */
drainOutbox().then((tally) => {
  console.log(`Outbox: ${tally.done} done, ${tally.skipped} skipped, ${tally.retried} to retry, ${tally.failed} failed.`);
  process.exit(0);
}, (err) => {
  console.error("Outbox drain failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
