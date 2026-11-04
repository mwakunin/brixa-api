/* eslint-disable no-console */
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";

import { createAccount } from "@/lib/accounts";

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
  console.error("Could not create the superadmin:", err instanceof Error ? err.message : err);
  process.exit(1);
});
