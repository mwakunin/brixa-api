/* eslint-disable no-console */
import { drainOutbox } from "@/jobs/outbox-worker";

/**
 * Runs one pass of the outbox worker by hand: `pnpm outbox:drain`.
 *
 * Until Cloud Tasks and Cloud Scheduler are wired (CLAUDE.md §7), this is how
 * an invitation email gets sent in development. Without Resend configured,
 * the email is printed to the console (lib/email.ts).
 */
drainOutbox().then((tally) => {
  console.log(`Outbox: ${tally.done} done, ${tally.skipped} skipped, ${tally.retried} to retry, ${tally.failed} failed.`);
  process.exit(0);
}, (err) => {
  console.error("Outbox drain failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
