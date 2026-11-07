import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent } from "stoker/openapi/helpers";

import { checkConnections } from "@/db";
import { createRouter } from "@/lib/create-app";

const HealthSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  /** `up` only when every connection below is. */
  database: z.enum(["up", "down"]),
  connections: z.object({
    owner: z.boolean(),
    app: z.boolean().describe("hospital_app: every tenant request"),
    auth: z.boolean().describe("hospital_auth: sign-in and sessions"),
  }),
  uptime: z.number().describe("Process uptime in seconds"),
});

const router = createRouter()
  .openapi(
    createRoute({
      tags: ["Health"],
      method: "get",
      path: "/health",
      summary: "Readiness check",
      description:
        "Verifies the process is up AND that each of its three database "
        + "connections can run a query, since each signs in as its own role. "
        + "Use this for readiness probes, not `GET /`.",
      responses: {
        [HttpStatusCodes.OK]: jsonContent(HealthSchema, "Everything is reachable"),
        [HttpStatusCodes.SERVICE_UNAVAILABLE]: jsonContent(HealthSchema, "A connection is down"),
      },
    }),
    async (c) => {
      // Each probe has a deadline covering every step, and Postgres caps the
      // query too (db/index.ts), so the probe fails rather than hangs.
      const { errors, ...connections } = await checkConnections();
      const up = connections.owner && connections.app && connections.auth;

      // Each failure with its role, in the log only: the response is public.
      if (!up)
        c.var.logger.error({ connections, errors }, "health check: a database connection is down");

      return c.json(
        {
          status: up ? "ok" as const : "degraded" as const,
          database: up ? "up" as const : "down" as const,
          connections,
          uptime: Math.round(process.uptime()),
        },
        up ? HttpStatusCodes.OK : HttpStatusCodes.SERVICE_UNAVAILABLE,
      );
    },
  );

export default router;
