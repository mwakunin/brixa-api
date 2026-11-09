import type { AppOpenAPI } from "@/lib/types";

import env from "@/env";
import configureOpenAPI from "@/lib/configure-open-api";
import createApp from "@/lib/create-app";
import adjustments from "@/routes/adjustments/adjustments.index";
import charges from "@/routes/charges/charges.index";
import documents from "@/routes/documents/documents.index";
import encounters from "@/routes/encounters/encounters.index";
import facility from "@/routes/facility/facility.index";
import health from "@/routes/health.route";
import index from "@/routes/index.route";
import internal from "@/routes/internal.route";
import invitations from "@/routes/invitations/invitations.index";
import invoices from "@/routes/invoices/invoices.index";
import localFiles from "@/routes/local-files.route";
import me from "@/routes/me/me.index";
import mpesa from "@/routes/mpesa/mpesa.index";
import patients from "@/routes/patients/patients.index";
import payments from "@/routes/payments/payments.index";
import prices from "@/routes/prices/prices.index";
import refunds from "@/routes/refunds/refunds.index";
import shifts from "@/routes/shifts/shifts.index";
import staff from "@/routes/staff/staff.index";
import superadmin from "@/routes/superadmin/superadmin.index";
import verify from "@/routes/verify/verify.index";
import wards from "@/routes/wards/wards.index";
import webhooks from "@/routes/webhooks/webhooks.index";

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
 * document. `webhooks` is Safaricom calling back: the token in the path names
 * the facility. `internal` is for Cloud Tasks and Cloud Scheduler alone, each
 * call carrying a Google-signed identity token.
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
  webhooks,
  internal,
] as const;

/**
 * The local storage driver's download links, served only while that driver
 * is configured; production cannot configure it (env.ts).
 */
const developmentRoutes = env.STORAGE_DRIVER === "local" ? [localFiles] : [];

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
  patients,
  encounters,
  wards,
  prices,
  charges,
  invoices,
  adjustments,
  shifts,
  payments,
  refunds,
  mpesa,
] as unknown as readonly AppOpenAPI[];

[...unscopedRoutes, ...developmentRoutes, ...tenantRoutes].forEach((route) => {
  app.route("/", route);
});

export type AppType = typeof unscopedRoutes[number];

export default app;
