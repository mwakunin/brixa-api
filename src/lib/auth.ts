import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { authDb } from "@/db";
import * as authSchema from "@/db/auth-schema";
import env from "@/env";

import { emailEnabled, sendEmail } from "./email";
import { errorLine } from "./error-summary";
import { logger } from "./logger";

/** The staff app's origin: scheme, host and port, whatever path APP_URL carries. */
export const appOrigin = new URL(env.APP_URL).origin;

/**
 * Sends a password email without letting its failure reach the response. A
 * reset request that failed only for a real account would tell a stranger
 * the account exists, and a notice that failed after the password changed
 * would report a change that happened as one that did not. The failure is
 * logged with the account's id, never its address (rule 10); the person can
 * ask again.
 */
async function sendQuietly(userId: string, what: string, mail: Parameters<typeof sendEmail>[0]): Promise<void> {
  try {
    await sendEmail(mail);
  }
  catch (err) {
    logger.error({ userId, error: errorLine(err) }, `Could not send the ${what}`);
  }
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
  advanced: {
    // Better Auth turns the origin check off by default under NODE_ENV=test.
    // Stated here so the suite tests the CSRF defence production runs.
    disableOriginCheck: false,
  },

  database: drizzleAdapter(authDb, {
    provider: "pg",
    schema: authSchema,
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
     * the same whether or not the address has an account, so it tells nobody
     * who has one, and the /api/auth rate limit covers it. The link goes
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
      await sendQuietly(recipient.id, "password reset link", {
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
      await sendQuietly(changed.id, "password changed notice", {
        to: changed.email,
        subject: "Your Brixa HMIS password was changed",
        body: `Hello ${changed.name},\n\n`
          + "The password for your Brixa HMIS account was changed, and every device that was signed in has been signed out.\n\n"
          + "If you did not do this, tell your administrator straight away.",
      });
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
