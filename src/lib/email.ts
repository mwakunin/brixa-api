import { randomUUID } from "node:crypto";
import { link, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Resend } from "resend";

import env from "@/env";

import { summarizeError } from "./error-summary";
import { logger } from "./logger";

/** One email, as every sender here writes it. */
export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
}

/** Counts the copies this process keeps, so two in one millisecond still sort in the order they were written. */
let devMailWritten = 0;

/**
 * Keeps an email a development API would have sent, as one JSON file in
 * `dir`: `{ to, subject, body, at }`. Development data is synthetic
 * (CLAUDE.md §8), but the links in these files work, so:
 *
 * - The folder and the files are for their owner only (0700, 0600).
 * - A file is complete before it has its name. It is written under a hidden
 *   name first, then linked to its own, which never replaces another file,
 *   so a reader never sees half a message.
 * - Names are the instant, this process's count, then a random part. The
 *   newest sorts last, even within one millisecond. The address stays inside
 *   the file, never in its name.
 */
export async function keepDevMail(dir: string, mail: EmailMessage, at: Date = new Date()): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  devMailWritten += 1;
  const name = `${at.toISOString().replace(/[:.]/g, "-")}-${String(devMailWritten).padStart(9, "0")}-${randomUUID().slice(0, 8)}`;
  const file = path.join(dir, `${name}.json`);
  const partial = path.join(dir, `.${name}.partial`);
  try {
    await writeFile(partial, `${JSON.stringify({ ...mail, at: at.toISOString() }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await link(partial, file);
  }
  finally {
    await rm(partial, { force: true });
  }
  return file;
}

/**
 * Transactional email, behind one interface so the provider can change in one
 * file (CLAUDE.md §2). Only sign-up verification mail is sent today, and it
 * runs outside any tenant transaction. Mail tied to a facility's records goes
 * through the outbox (rule 18) once that exists.
 */

/** Both halves are required together, so one check covers the feature. */
export const emailEnabled = Boolean(env.RESEND_API_KEY && env.RESEND_FROM_EMAIL);

/**
 * Whether a caller should attempt to send.
 *
 * Deliberately not the same question as `emailEnabled`, which decides policy —
 * Better Auth requires email verification exactly when real mail can go out,
 * and turning that on in the test environment would mean sign-up no longer
 * returns a session.
 *
 * Under test, `sendEmail` captures into `sentEmails` instead of calling
 * Resend, so senders must still run or nothing about them is ever exercised.
 * Gating them on `emailEnabled` would leave every notification test passing
 * without sending anything.
 */
export const emailDeliverable = emailEnabled || env.NODE_ENV === "test";

const client = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

/** Test seam: mail captured instead of sent when NODE_ENV=test. */
export const sentEmails: EmailMessage[] = [];

export class EmailError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "EmailError";
  }
}

export async function sendEmail(input: EmailMessage): Promise<void> {
  if (env.NODE_ENV === "test") {
    sentEmails.push(input);
    return;
  }

  if (!client || !env.RESEND_FROM_EMAIL) {
    /*
     * A developer's machine with no mail provider prints the message, so an
     * invitation link can still be followed. Dev data is synthetic (CLAUDE.md
     * §8). Production cannot reach here: env.ts requires RESEND_* there.
     */
    if (env.NODE_ENV === "development") {
      console.warn(`[dev email] to ${input.to}: ${input.subject}\n${input.body}`);
      await keepDevMail(env.DEV_MAIL_DIR, input).catch((err: unknown) => {
        logger.warn({ error: summarizeError(err) }, "Could not keep a copy of a development email");
      });
      return;
    }
    throw new EmailError("Email is not configured (RESEND_API_KEY / RESEND_FROM_EMAIL)");
  }

  const { error } = await client.emails.send({
    from: env.RESEND_FROM_EMAIL,
    to: input.to,
    subject: input.subject,
    text: input.body,
  });

  if (error)
    throw new EmailError(`Resend rejected the message: ${error.message}`, error);
}
