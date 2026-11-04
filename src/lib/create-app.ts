import type { Schema } from "hono";

import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { notFound, serveEmojiFavicon } from "stoker/middlewares";
import { defaultHook } from "stoker/openapi";

import { withSession } from "@/middlewares/auth";
import { pinoLogger } from "@/middlewares/pino-logger";
import { rateLimits } from "@/middlewares/rate-limit";

import type { AppBindings, AppOpenAPI, TenantBindings } from "./types";

import { appOrigin, auth } from "./auth";
import { FACILITY_HEADER } from "./constants";
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

/**
 * Cross-origin access for the staff app, and only for it.
 *
 * The app (APP_URL) calls this API from its own origin with the session
 * cookie, so the browser needs credentialed CORS naming that exact origin. A
 * request from any other origin gets no CORS headers, and its browser refuses
 * to hand it the response. Registered first, so a preflight is answered before
 * the rate limiter or `withFacility` sees it. If the API is later served from
 * the app's own origin through a proxy, this simply never fires.
 */
function staffAppCors() {
  return cors({
    origin: origin => (origin === appOrigin ? origin : null),
    credentials: true,
    allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
    allowHeaders: ["content-type", FACILITY_HEADER],
    exposeHeaders: ["retry-after"],
    maxAge: 600,
  });
}

/**
 * Response headers that harden every answer. HSTS is the one encryption in
 * transit rests on (docs/certification/encryption.md): once a browser has
 * seen it, it will not speak plain HTTP to this API again. Resources may be
 * read by the staff app's site, not only this origin, since the app opens a
 * document's PDF from its own pages.
 */
function hardenedHeaders() {
  return secureHeaders({
    strictTransportSecurity: "max-age=31536000; includeSubDomains",
    crossOriginResourcePolicy: "same-site",
  });
}

export default function createApp() {
  const app = createRouter();
  app.use(staffAppCors())
    .use(hardenedHeaders())
    .use(requestId())
    .use(serveEmojiFavicon("🏥"))
    .use(pinoLogger());

  // Better Auth owns everything under /api/auth. Mounted before withSession so
  // the handler manages its own cookies. The POSTs (sign-in, password flows)
  // are tightly limited by address: they are the brute-force and enumeration
  // targets. Sign-in also counts per account named: tightly from each
  // address, so an attacker's guesses cannot lock the owner out, and loosely
  // from anywhere, so a guess spread across many addresses is still capped.
  // The per-address limit runs first, so a refused attempt never counts
  // against the account's shared budget. The GETs only stop a flood: a staff
  // app checks its session constantly.
  app.post("/api/auth/sign-in/email", rateLimits.signInAccountFromAddress(), rateLimits.signInAccount());
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
