/* eslint-disable no-console */
import { DEV_BACKUP_CODES, developmentCode } from "@/dev/two-factor";
import { errorLine } from "@/lib/error-summary";

/**
 * The sign-in code of every seeded account, for signing in by hand:
 *
 *   pnpm dev:code
 *
 * They share one authenticator secret (`src/dev/two-factor.ts`), so this
 * code is right for all of them until it changes, every 30 seconds.
 */
async function main() {
  console.log(`Code: ${await developmentCode()} (changes every 30 seconds)`);
  console.log(`Backup codes, if you are testing those: ${DEV_BACKUP_CODES[0]} to ${DEV_BACKUP_CODES.at(-1)}`);
}

main().then(() => process.exit(0), (err: unknown) => {
  // A database error's message carries its SQL parameters (CLAUDE.md rule 10).
  console.error("Could not work out the code:", errorLine(err));
  process.exit(1);
});
