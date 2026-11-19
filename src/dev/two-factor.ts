import { symmetricEncrypt } from "better-auth/crypto";

import env from "@/env";
import { auth } from "@/lib/auth";

/**
 * Two-step sign-in for made-up accounts: the dev seed's and the tests'.
 *
 * Every such account shares one authenticator secret, written here in the
 * open, so a script can work out the code, and a developer can sign in by
 * hand with `pnpm dev:code` (docs/development.md). That is why none of this
 * runs in production: there, a secret is made when a person sets up their
 * own authenticator, and nobody else ever sees it.
 */

/** The authenticator secret of every seeded and test account. 32 characters, as the plugin's own are. */
export const DEV_TOTP_SECRET = "brixa-dev-totp-secret-not-secret";

/** Their ten backup codes, digits in the production shape (lib/auth.ts), so a number pad can type them. */
export const DEV_BACKUP_CODES = Array.from({ length: 10 }, (_, i) => `00000-${String(i + 1).padStart(5, "0")}`);

/**
 * Gives an account the development authenticator and backup codes, as if its
 * owner had set them up, through Better Auth's adapter so the row is the one
 * its sign-in expects.
 */
export async function enrolForDevelopment(userId: string): Promise<void> {
  if (env.NODE_ENV === "production")
    throw new Error("The development authenticator is public: refused in production.");

  const context = await auth.$context;
  const [secret, backupCodes] = await Promise.all([
    symmetricEncrypt({ key: context.secretConfig, data: DEV_TOTP_SECRET }),
    symmetricEncrypt({ key: context.secretConfig, data: JSON.stringify(DEV_BACKUP_CODES) }),
  ]);
  await context.adapter.create({
    model: "twoFactor",
    data: { userId, secret, backupCodes, verified: true },
  });
  await context.internalAdapter.updateUser(userId, { twoFactorEnabled: true });
}

/** The development authenticator's code right now. It changes every 30 seconds. */
export async function developmentCode(): Promise<string> {
  const { code } = await auth.api.generateTOTP({ body: { secret: DEV_TOTP_SECRET } });
  return code;
}
