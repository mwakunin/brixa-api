import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { authDb } from "@/db";
import * as authSchema from "@/db/auth-schema";
import env from "@/env";

import { emailEnabled, sendEmail } from "./email";

/** The staff app's origin: scheme, host and port, whatever path APP_URL carries. */
export const appOrigin = new URL(env.APP_URL).origin;

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
