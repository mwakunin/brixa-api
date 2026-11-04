import { Resend } from "resend";

import env from "@/env";

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
export const sentEmails: Array<{ to: string; subject: string; body: string }> = [];

export class EmailError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "EmailError";
  }
}

export async function sendEmail(input: {
  to: string;
  subject: string;
  body: string;
}): Promise<void> {
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
