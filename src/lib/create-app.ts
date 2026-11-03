import type { Schema } from "hono";

import { OpenAPIHono } from "@hono/zod-openapi";
import { requestId } from "hono/request-id";
import { notFound, serveEmojiFavicon } from "stoker/middlewares";
import { defaultHook } from "stoker/openapi";

import { withSession } from "@/middlewares/auth";
import { pinoLogger } from "@/middlewares/pino-logger";
import { rateLimits } from "@/middlewares/rate-limit";

import type { AppBindings, AppOpenAPI, TenantBindings } from "./types";

import { auth } from "./auth";
import { onError } from "./on-error";

export function createRouter() {
  return new OpenAPIHono<AppBindings>({
    strict: false,
    defaultHook,
  });
}

/**
 * A router for routes that act inside one facility.
 *
 * Differs from `createRouter` only in its bindings, and that is the point:
 * `c.var.db` exists on this type and not the other, so a tenant route reaching
 * for a module-level connection is a type error. Mount these behind
 * `withFacility`.
 */
export function createTenantRouter() {
  return new OpenAPIHono<TenantBindings>({
    strict: false,
    defaultHook,
  });
}

export default function createApp() {
  const app = createRouter();
  app.use(requestId())
    .use(serveEmojiFavicon("🏥"))
    .use(pinoLogger());

  // Better Auth owns everything under /api/auth. Mounted before withSession so
  // the handler manages its own cookies. The POSTs (sign-in, password flows)
  // are tightly limited by address: they are the brute-force and enumeration
  // targets. Sign-in also counts per account named, so a guess spread across
  // many addresses cannot multiply the attempts one account takes. The GETs
  // only stop a flood: a staff app checks its session constantly.
  app.post("/api/auth/sign-in/email", rateLimits.signInAccount());
  app.post("/api/auth/*", rateLimits.auth(), c => auth.handler(c.req.raw));
  app.get("/api/auth/*", rateLimits.authRead(), c => auth.handler(c.req.raw));

  // Resolves the session onto every request; routes opt into requiring it.
  app.use(withSession);

  app.notFound(notFound);
  app.onError(onError);
  return app;
}

export function createTestApp<S extends Schema>(router: AppOpenAPI<S>) {
  return createApp().route("/", router);
}
