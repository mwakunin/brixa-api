import type { MiddlewareHandler } from "hono";

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { and, eq } from "drizzle-orm";
import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as sleep } from "node:timers/promises";

import { authDb } from "@/db";
import * as authSchema from "@/db/auth-schema";
import env from "@/env";

import { emailEnabled, EmailError, sendEmail } from "./email";
import { errorLine, summarizeError } from "./error-summary";
import { logger } from "./logger";

/** The staff app's origin: scheme, host and port, whatever path APP_URL carries. */
export const appOrigin = new URL(env.APP_URL).origin;

/**
 * Better Auth's own log lines, written through the process's logger. It logs
 * an unexpected error whole, and a database error's message carries its SQL
 * parameters: a reset token being looked up, an email address (rule 10). So
 * the message is cut to its first line without parameters, and each argument
 * to what errorLine keeps.
 */
export function logForBetterAuth(level: "debug" | "info" | "warn" | "error", message: string, ...args: unknown[]): void {
  const detail = args.map(errorLine);
  logger[level]({ source: "better-auth", ...(detail.length > 0 ? { detail } : {}) }, summarizeError(message).message);
}

/**
 * Sends a password email without letting its failure reach the response. A
 * reset request that failed only for a real account would tell a stranger
 * the account exists, and a notice that failed after the password changed
 * would report a change that happened as one that did not. The failure is
 * logged with the account's id and the kind of failure, never the
 * provider's message: Resend's can quote an email address (rule 10). The
 * person can ask again.
 */
async function sendQuietly(userId: string, what: string, mail: Parameters<typeof sendEmail>[0]): Promise<void> {
  try {
    await sendEmail(mail);
  }
  catch (err) {
    logger.error({ userId, failure: failureKind(err) }, `Could not send the ${what}`);
  }
}

/** Resend's error name (`rate_limit_exceeded`, `validation_error`…) when there is one, else the error's class. */
function failureKind(err: unknown): string {
  const cause = err instanceof EmailError ? err.cause : undefined;
  if (typeof cause === "object" && cause !== null && "name" in cause && typeof cause.name === "string")
    return cause.name;
  return err instanceof Error ? err.name : typeof err;
}

/**
 * How long a request for a reset link takes to answer, whatever happens
 * behind it (`middlewares/answer-time.ts`), so an address with an account is
 * not told apart by the wait.
 */
export const RESET_REQUEST_ANSWER_MS = 1_500;

/** When the password sign-in being handled began; see `markSignInStart`. */
const signInBegan = new AsyncLocalStorage<Date>();

/**
 * Runs a password sign-in inside a record of when it began, for the session
 * hook below to compare with the last password change. Mounted on POST
 * /api/auth/sign-in/email (create-app.ts).
 */
export const markSignInStart: MiddlewareHandler = (_c, next) => signInBegan.run(new Date(), next);

/**
 * How long a reset waits for the "password changed" notice before answering.
 * The Resend SDK sets no timeout, so a stalled provider would otherwise hold
 * the answer for minutes, and someone who gave up and pressed again would be
 * told their link was used. A slower notice finishes after the answer.
 */
const NOTICE_WAIT_MS = 1_000;

/**
 * Email and password, for staff at a desk. Invite-only.
 *
 * There is no public sign-up: a hospital's staff are known to it, so an
 * account is created on the server for a specific person, and staff accounts
 * will come from an invitation by the facility admin (the onboarding slice).
 * An open sign-up endpoint would only hand strangers accounts with no
 * membership, and an address to squat on: `user.email` is UNIQUE.
 *
 * Phone OTP (the school SaaS keeps it dormant) is not ported: v1 has no
 * patient portal, and staff accounts all have an email address.
 *
 * The adapter uses its own connection (`authDb`, role `hospital_auth`): the
 * only role that can read sessions and password hashes. The auth tables carry
 * no tenant policies, because identity is global and one person may hold
 * memberships at several facilities, so the role tenant handlers run as is
 * kept away from them.
 */
export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  /*
   * The staff app runs at its own origin (APP_URL), not the API's. Better
   * Auth refuses a cookie-bearing request from any origin it does not trust,
   * which is its CSRF defence, so the app's origin is the one it adds.
   */
  trustedOrigins: [appOrigin],
  logger: { log: logForBetterAuth },
  advanced: {
    // Better Auth turns the origin check off by default under NODE_ENV=test.
    // Stated here so the suite tests the CSRF defence production runs.
    disableOriginCheck: false,
  },

  database: drizzleAdapter(authDb, {
    provider: "pg",
    schema: authSchema,
    // A reset spends its link, ends the sessions and writes the password together, or does none of it.
    transaction: true,
  }),

  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    /**
     * Required wherever mail can be sent, which is production (RESEND_* is
     * mandatory there): a person signs in only once their address is proven.
     * Off in dev and test only because there is no mail provider there.
     */
    requireEmailVerification: emailEnabled,
    minPasswordLength: 10,

    /*
     * A forgotten password, reset by email. Better Auth answers the request
     * with the same words whether or not the address has an account, and
     * RESET_REQUEST_ANSWER_MS makes it take the same time, so it tells nobody
     * who has one; the /api/auth rate limit covers it too. The link goes
     * straight to the staff app's reset page, as an invitation's does, and
     * works for an hour, once.
     *
     * No administrator resets someone else's password, and none ever sees a
     * reset link: an account can belong to several facilities, and one
     * facility's admin must not be able to take over its access at another.
     */
    resetPasswordTokenExpiresIn: 60 * 60,
    async sendResetPassword({ user: recipient, token }) {
      const link = new URL("/reset-password", env.APP_URL);
      link.searchParams.set("token", token);
      /*
       * Not awaited, so the provider's time never reaches the answer. The
       * answer is held to RESET_REQUEST_ANSWER_MS anyway, which gives the
       * send that long inside the request; a slower one finishes after it.
       * sendQuietly never rejects, so a failure goes only into the log.
       */
      void sendQuietly(recipient.id, "password reset link", {
        to: recipient.email,
        subject: "Reset your Brixa HMIS password",
        body: `Hello ${recipient.name},\n\n`
          + "Someone asked to reset the password for your Brixa HMIS account. Open this link to choose a new one:\n\n"
          + `${link.toString()}\n\n`
          + "The link works once, for one hour. If you did not ask for this, you can ignore it: your password stays as it is.",
      });
    },
    // A reset often follows "someone else may know my password", and the computers at a desk are shared.
    revokeSessionsOnPasswordReset: true,
    // The person hears of every change, so one they did not make does not go unnoticed.
    async onPasswordReset({ user: changed }) {
      logger.info({ userId: changed.id }, "Password reset");
      const notice = sendQuietly(changed.id, "password changed notice", {
        to: changed.email,
        subject: "Your Brixa HMIS password was changed",
        body: `Hello ${changed.name},\n\n`
          + "The password for your Brixa HMIS account was changed, and every device that was signed in has been signed out.\n\n"
          + "If you did not do this, tell your administrator straight away.",
      });
      await Promise.race([notice, sleep(NOTICE_WAIT_MS)]);
    },
  },

  databaseHooks: {
    session: {
      create: {
        /*
         * Better Auth checks a password, slowly by design, and then creates
         * the session without looking at the password again. A sign-in that
         * checked the old password while a reset was committing would get a
         * session after the reset had signed everyone out. So a session for
         * a password sign-in is refused when the password changed after that
         * sign-in began, and the sign-in answers as for a wrong password. One
         * begun after the change goes through. What remains is the instant
         * between the reset's write and its commit.
         */
        async before(session) {
          const began = signInBegan.getStore();
          if (!began)
            return;
          const [credential] = await authDb
            .select({ changedAt: authSchema.account.updatedAt })
            .from(authSchema.account)
            .where(and(eq(authSchema.account.userId, session.userId), eq(authSchema.account.providerId, "credential")));
          if (credential && credential.changedAt > began)
            return false;
        },
      },
    },
  },

  emailVerification: {
    autoSignInAfterVerification: true,
    async sendVerificationEmail({ user: recipient, url }) {
      await sendEmail({
        to: recipient.email,
        subject: "Confirm your email address",
        body: `Confirm your email address to finish setting up your account:\n\n${url}\n\n`
          + "If you were not expecting this, you can ignore it.",
      });
    },
  },

  user: {
    additionalFields: {
      role: {
        type: "string",
        defaultValue: "user",
        // Never settable from the client: privilege escalation otherwise.
        input: false,
      },
    },
  },
});

export type Auth = typeof auth;
export type Session = Auth["$Infer"]["Session"];
