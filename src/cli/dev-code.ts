/* eslint-disable no-console */
import { DEV_BACKUP_CODES, developmentCode } from "@/dev/two-factor";

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
  console.error("Could not work out the code:", err instanceof Error ? err.message : err);
  process.exit(1);
});
