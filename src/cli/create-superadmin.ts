/* eslint-disable no-console */
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";

import { createAccount } from "@/lib/accounts";
import { errorLine } from "@/lib/error-summary";

/**
 * Creates a platform superadmin: the one account that cannot come from an
 * invitation, because inviting needs someone already signed in.
 *
 *   pnpm superadmin:create --email you@example.com --name "Your Name"
 *
 * The password is generated and printed once, never stored anywhere but as
 * Better Auth's hash. Change it after first sign-in. Run with the target
 * environment's .env (or env vars): it writes to that database.
 */
async function main() {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      name: { type: "string" },
    },
  });

  if (!values.email || !values.name) {
    console.error("Usage: pnpm superadmin:create --email you@example.com --name \"Your Name\"");
    process.exit(2);
  }

  const password = randomBytes(18).toString("base64url");
  const created = await createAccount({
    email: values.email,
    name: values.name,
    password,
    role: "superadmin",
  });

  console.log(`Superadmin ${created.email} created.`);
  console.log(`Password (shown once): ${password}`);
}

main().then(() => process.exit(0), (err) => {
  // A database error's message carries its SQL parameters (CLAUDE.md rule 10).
  console.error("Could not create the superadmin:", errorLine(err));
  process.exit(1);
});
