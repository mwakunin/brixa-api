/* eslint-disable no-console */
import { serve } from "@hono/node-server";

import app from "./app";
import { assertConnectionsAreRestricted, PrivilegedRoleError } from "./db";
import env from "./env";
import { startingUpResponse } from "./lib/starting-up";
import { createStartupGate } from "./lib/startup-gate";

/*
 * No request is served until the app and auth roles are proven unable to
 * bypass row-level security (lib/startup-gate.ts).
 *
 * A privileged role stops the process: retrying cannot fix it. An unreachable
 * database does not: the check retries in the background, every request but
 * /health is answered 503 meanwhile, and /health shows which connection is
 * down, which is what a readiness probe needs to see.
 */
const gate = createStartupGate({
  verify: assertConnectionsAreRestricted,
  isFatal: err => err instanceof PrivilegedRoleError,
  onFatal: (err) => {
    console.error((err as Error).message);
    process.exit(1);
  },
  onRetry: err => console.warn("Database roles not verified yet; retrying:", (err as Error).message),
  refuse: startingUpResponse,
});

await gate.start();

const port = env.PORT;
console.log(`Server is running on http://localhost:${port}`);

serve({
  fetch: gate.wrap(app.fetch),
  port,
});
