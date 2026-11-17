/* eslint-disable no-console */
import { seedDevelopment } from "@/dev/seed";
import { errorLine } from "@/lib/error-summary";

/**
 * Seeds the development database with a made-up hospital at work:
 *
 *   pnpm db:seed
 *
 * Refuses production, a database not on this machine, email or SMS
 * credentials, and a database seeded already (`src/dev/seed.ts`).
 *
 * It drives the API in this process, signing in a dozen made-up staff one
 * after another. Each request it writes names its own forwarded address, and
 * the script runs with `TRUST_PROXY_HOPS=1` (package.json), so this process
 * alone trusts that header and the per-address sign-in limits see many
 * callers rather than one.
 */
async function main() {
  const seeded = await seedDevelopment();
  console.log(`Seeded ${seeded.staff.length} members of staff at Sample Hospital. Every password: ${seeded.password}`);
  for (const member of seeded.staff)
    console.log(`  ${member.desk.padEnd(14)} ${member.email.padEnd(36)} ${member.name}`);
}

main().then(() => process.exit(0), (err) => {
  // A database error's message carries its SQL parameters (CLAUDE.md rule 10).
  console.error("Could not seed:", err instanceof Error && err.name === "SeedError" ? err.message : errorLine(err));
  process.exit(1);
});
