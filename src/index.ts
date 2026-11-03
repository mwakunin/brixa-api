/* eslint-disable no-console */
import { serve } from "@hono/node-server";

import app from "./app";
import { assertConnectionsAreRestricted, PrivilegedRoleError } from "./db";
import env from "./env";

/*
 * Checked before serving, so a privileged app or auth role never answers a
 * single request: its limits would be inert. The process exits.
 *
 * An unreachable database does not stop the process: it still serves, and
 * /health reports the database as down, which is what a readiness probe needs
 * to see. The wait is bounded by the pool's connection timeout.
 */
try {
  await assertConnectionsAreRestricted();
}
catch (err) {
  if (err instanceof PrivilegedRoleError) {
    console.error(err.message);
    process.exit(1);
  }
  console.warn("Could not verify the database roles at boot (database unreachable?):", (err as Error).message);
}

const port = env.PORT;
console.log(`Server is running on http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
});
