import type { AppOpenAPI } from "@/lib/types";

import configureOpenAPI from "@/lib/configure-open-api";
import createApp from "@/lib/create-app";
import documents from "@/routes/documents/documents.index";
import facility from "@/routes/facility/facility.index";
import health from "@/routes/health.route";
import index from "@/routes/index.route";
import invitations from "@/routes/invitations/invitations.index";
import me from "@/routes/me/me.index";
import staff from "@/routes/staff/staff.index";
import superadmin from "@/routes/superadmin/superadmin.index";
import verify from "@/routes/verify/verify.index";

const app = createApp();

configureOpenAPI(app);

/**
 * Routes outside any facility: no tenant transaction, no `c.var.db`.
 *
 * `me` lists a user's own memberships, which is what lets them choose a
 * facility in the first place. `superadmin` works across facilities on the
 * owner connection. `invitations` is reached from an emailed link, with no
 * session and no facility: the token names the invitation. `verify` is
 * reached from a printed document's QR code, the same way: the code names the
 * document.
 *
 * These must stay ahead of the tenant routers, which register `withFacility`
 * at `/*` (app.test.ts checks it).
 */
const unscopedRoutes = [
  index,
  health,
  me,
  superadmin,
  invitations,
  verify,
] as const;

/**
 * Routers whose handlers see `facility`, `membership` and `db`.
 *
 * The cast is a limitation of Hono's types, not a hole: `app.route()` needs the
 * sub-app's Env to be assignable to the parent's, and a tenant router's Env has
 * strictly more variables. Each sub-router carries `withFacility` itself, so
 * the variables are set before any of its handlers runs, and inside the router
 * the strong typing still holds.
 */
const tenantRoutes = [
  facility,
  staff,
  documents,
] as unknown as readonly AppOpenAPI[];

[...unscopedRoutes, ...tenantRoutes].forEach((route) => {
  app.route("/", route);
});

export type AppType = typeof unscopedRoutes[number];

export default app;
