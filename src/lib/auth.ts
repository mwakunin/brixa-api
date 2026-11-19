import type { BetterAuthPlugin } from "better-auth";
import type { MiddlewareHandler } from "hono";

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { twoFactor } from "better-auth/plugins/two-factor";
import { and, eq, like, ne } from "drizzle-orm";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomInt } from "node:crypto";
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

/** What the sign-in being handled rests on, for the session hook and `twoFactorRules` below. */
interface SignInBasis {
  /** When its password was checked; null when no password is behind it (setting an authenticator up). */
  checkedAt: Date | null;
  /** Set when this request confirmed a new authenticator. */
  enrolled: boolean;
}

const signInBasis = new AsyncLocalStorage<SignInBasis>();

/**
 * Runs a password sign-in inside a record of when it began, for the session
 * hook below to compare with the last password change. Mounted on POST
 * /api/auth/sign-in/email (create-app.ts).
 */
export const markSignInStart: MiddlewareHandler = (_c, next) => signInBasis.run({ checkedAt: new Date(), enrolled: false }, next);

/**
 * The same for a code (create-app.ts, on the two verify routes). When its
 * password was checked is read from its challenge by `twoFactorRules`,
 * before the plugin spends the challenge.
 */
export const markCodeCheck: MiddlewareHandler = (_c, next) => signInBasis.run({ checkedAt: null, enrolled: false }, next);

/**
 * How long a change to how someone signs in waits for its notice before
 * answering. The Resend SDK sets no timeout, so a stalled provider would
 * otherwise hold the answer for minutes, and someone who gave up and pressed
 * again would be told their reset link was used. A slower notice finishes
 * after the answer.
 */
const NOTICE_WAIT_MS = 1_000;

/**
 * Tells a person that how they sign in has changed, so a change they did not
 * make does not go unnoticed. Waits for the email no longer than
 * NOTICE_WAIT_MS, and never fails the change it reports.
 */
async function notify(changed: { id: string; email: string; name: string }, what: string, subject: string, news: string): Promise<void> {
  const notice = sendQuietly(changed.id, what, {
    to: changed.email,
    subject,
    body: `Hello ${changed.name},\n\n${news}\n\nIf you did not do this, tell your administrator straight away.`,
  });
  await Promise.race([notice, sleep(NOTICE_WAIT_MS)]);
}

/**
 * One backup code: ten digits, five and five, as `12345-67890`. They are
 * printed or written down, and typed back at a desk, so they have no letter
 * to mistake for a digit and no case to get wrong. Ten digits are plenty
 * here: each try needs the password first, a challenge takes five tries, and
 * five wrong codes in a row lock the account.
 */
function backupCode(): string {
  const five = () => String(randomInt(100_000)).padStart(5, "0");
  return `${five()}-${five()}`;
}

/** Whether this person's password changed after `since`: a sign-in that checked it before then rests on an old one. */
async function passwordChangedSince(userId: string, since: Date): Promise<boolean> {
  const [credential] = await authDb
    .select({ changedAt: authSchema.account.updatedAt })
    .from(authSchema.account)
    .where(and(eq(authSchema.account.userId, userId), eq(authSchema.account.providerId, "credential")));
  return credential !== undefined && credential.changedAt > since;
}

/**
 * Brixa's rules on top of the two-factor plugin's own.
 *
 * No computer is ever remembered: the computers at a desk are shared, so a
 * code is asked at every sign-in, and a request to skip it next time is
 * refused rather than ignored.
 *
 * A code's sign-in rests on the password checked when its challenge was
 * made. A code whose password has changed since is refused before the
 * plugin spends the challenge, as a sign-in to start again. The challenge's
 * time is also kept for the session hook below, which refuses the session
 * when a reset commits after the challenge is spent; that rare race answers
 * 500 (Better Auth's "failed to create session"), with no session made.
 *
 * Confirming a new authenticator ends every other session the person has:
 * each was made by the password alone, and would otherwise carry on as if it
 * had been given a code.
 */
function twoFactorRules(): BetterAuthPlugin {
  const isCodeCheck = (path: string | undefined) => path?.startsWith("/two-factor/verify-") === true;
  return {
    id: "brixa-two-factor-rules",
    hooks: {
      before: [{
        matcher: context => isCodeCheck(context.path),
        handler: createAuthMiddleware(async (ctx) => {
          const body = ctx.body as { trustDevice?: unknown } | undefined;
          if (body?.trustDevice === true) {
            throw new APIError("BAD_REQUEST", {
              message: "This computer cannot be remembered: a code is asked at every sign-in.",
              code: "TRUST_DEVICE_NOT_ALLOWED",
            });
          }
          const basis = signInBasis.getStore();
          const cookie = ctx.context.createAuthCookie("two_factor");
          const challenge = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
          const found = challenge ? await ctx.context.internalAdapter.findVerificationValue(challenge) : null;
          if (!basis || !found)
            return;
          // Made just after the password was checked.
          basis.checkedAt = found.createdAt;
          if (await passwordChangedSince(found.value, found.createdAt)) {
            throw new APIError("UNAUTHORIZED", {
              message: "The password changed after this sign-in began. Sign in again.",
              code: "INVALID_TWO_FACTOR_COOKIE",
            });
          }
        }),
      }],
      after: [{
        matcher: context => isCodeCheck(context.path),
        handler: createAuthMiddleware(async (ctx) => {
          if (isAPIError(ctx.context.returned))
            return;
          const created = ctx.context.newSession;
          if (created && signInBasis.getStore()?.enrolled) {
            await authDb
              .delete(authSchema.session)
              .where(and(eq(authSchema.session.userId, created.user.id), ne(authSchema.session.id, created.session.id)));
          }
        }),
      }],
    },
  };
}

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
 * Two-step sign-in (SPEC.md §2): after the password, a code from an
 * authenticator app, or one of ten printed backup codes, at every sign-in.
 * Nobody may skip it: until a person has set their authenticator up, their
 * session is good for setting it up and nothing else (middlewares/auth.ts).
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
  /*
   * Better Auth's own rate limiter is off. create-app.ts limits every auth
   * route in Redis, shared by every instance, by the address the trusted
   * proxies report (middlewares/rate-limit.ts). Better Auth's counts in each
   * instance's memory, and allows three sign-ins or code checks in ten
   * seconds from one address: a hospital's staff share one, and a shift
   * change would trip it.
   */
  rateLimit: { enabled: false },
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
    async onPasswordReset({ user: changed }) {
      logger.info({ userId: changed.id }, "Password reset");
      /*
       * A sign-in waiting for its code began with the old password, so it
       * ends too, as a session would. Its challenge is a verification row
       * named `2fa-…` holding the person's id (the two-factor plugin's).
       */
      await authDb
        .delete(authSchema.verification)
        .where(and(eq(authSchema.verification.value, changed.id), like(authSchema.verification.identifier, "2fa-%")));
      await notify(
        changed,
        "password changed notice",
        "Your Brixa HMIS password was changed",
        "The password for your Brixa HMIS account was changed, and every device that was signed in has been signed out.",
      );
    },
  },

  databaseHooks: {
    user: {
      update: {
        /*
         * Setting an authenticator up, or turning two-step sign-in off, is
         * told to the person as a password change is. The plugin sets the
         * flag on only once the first code from a new authenticator is
         * right, and off only through /two-factor/disable, which asks for
         * the password; turned off, the next thing the API asks of them is a
         * new authenticator.
         */
        async after(updated, ctx) {
          const enabled = (updated as { twoFactorEnabled?: boolean | null }).twoFactorEnabled === true;
          if (ctx?.path === "/two-factor/verify-totp" && enabled) {
            // For twoFactorRules: the person's other sessions, made by the password alone, now end.
            const basis = signInBasis.getStore();
            if (basis)
              basis.enrolled = true;
            await notify(
              updated,
              "authenticator set up notice",
              "Two-step sign-in is set up on your Brixa HMIS account",
              "An authenticator app was set up for your Brixa HMIS account. From now on, signing in asks for a code from it.",
            );
          }
          else if (ctx?.path === "/two-factor/disable" && !enabled) {
            await notify(
              updated,
              "two-step sign-in off notice",
              "Two-step sign-in was turned off on your Brixa HMIS account",
              "Two-step sign-in was turned off for your Brixa HMIS account. You will be asked to set up an authenticator app again before you can work.",
            );
          }
        },
      },
    },
    session: {
      create: {
        /*
         * Better Auth checks a password, slowly by design, and then creates
         * the session without looking at the password again. A sign-in that
         * checked the old password while a reset was committing would get a
         * session after the reset had signed everyone out. So a session is
         * refused when the password changed after the sign-in's password was
         * checked: a password sign-in then answers as for a wrong password.
         * With two-step sign-in the password step's session becomes the
         * challenge for a code, and the same check runs again when the code
         * makes the real session, against when the challenge was made
         * (twoFactorRules), since a reset can commit after the challenge is
         * spent; onPasswordReset ends the challenges not yet spent. One begun
         * after the change goes through.
         *
         * This narrows the race; it does not close it. The read below and
         * Better Auth's session insert are separate statements, so a reset
         * that commits between them still leaves an old-password session.
         * Closing it needs a lock or a credential version inside Better Auth,
         * where sign-in and reset could be ordered against each other.
         */
        async before(session) {
          const began = signInBasis.getStore()?.checkedAt;
          if (began && await passwordChangedSince(session.userId, began))
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

  plugins: [
    twoFactor({
      issuer: "Brixa HMIS",
      // Five wrong codes in a row lock the account for fifteen minutes,
      // wherever they come from: reaching the code takes the password already.
      accountLockout: { maxFailedAttempts: 5, durationSeconds: 15 * 60 },
      backupCodeOptions: { customBackupCodesGenerate: () => Array.from({ length: 10 }, backupCode) },
    }),
    twoFactorRules(),
  ],

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
