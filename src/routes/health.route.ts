import { createRoute, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent } from "stoker/openapi/helpers";

import db from "@/db";
import { createRouter } from "@/lib/create-app";

const HealthSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  database: z.enum(["up", "down"]),
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
        "Verifies the process is up AND that it can reach the database. Use "
        + "this for load-balancer / container readiness probes, not `GET /`.",
      responses: {
        [HttpStatusCodes.OK]: jsonContent(HealthSchema, "Everything is reachable"),
        [HttpStatusCodes.SERVICE_UNAVAILABLE]: jsonContent(
          HealthSchema,
          "The database is unreachable",
        ),
      },
    }),
    async (c) => {
      let database: "up" | "down" = "up";

      try {
        /*
         * Bounded on both halves, and bounded by Postgres rather than by a
         * timer here.
         *
         * Waiting for a connection is capped by the pool's
         * `connectionTimeoutMillis` (see db/index.ts). Running the query is
         * capped by a transaction-local `statement_timeout`, so a probe that
         * outlives its welcome is cancelled server-side instead of being
         * abandoned client-side while the backend keeps working — which is
         * what a bare `Promise.race` would do, and why this is not one.
         *
         * A readiness probe that can hang is worse than one that fails: the
         * load balancer learns nothing either way, but a hung probe also holds
         * a connection while it does so.
         */
        await db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL statement_timeout = 2000`);
          await tx.execute(sql`select 1`);
        });
      }
      catch (err) {
        database = "down";
        c.var.logger.error({ err }, "health check: database unreachable");
      }

      const body = {
        status: database === "up" ? "ok" as const : "degraded" as const,
        database,
        uptime: Math.round(process.uptime()),
      };

      return c.json(
        body,
        database === "up"
          ? HttpStatusCodes.OK
          : HttpStatusCodes.SERVICE_UNAVAILABLE,
      );
    },
  );

export default router;
