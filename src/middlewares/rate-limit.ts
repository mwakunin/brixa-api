import type { Context } from "hono";
import type { Redis } from "ioredis";
import type { RateLimiterRes } from "rate-limiter-flexible";

import { getConnInfo } from "@hono/node-server/conninfo";
import { createMiddleware } from "hono/factory";
import { createHmac } from "node:crypto";
import { RateLimiterMemory, RateLimiterRedis } from "rate-limiter-flexible";
import * as HttpStatusCodes from "stoker/http-status-codes";

import type { AppBindings } from "@/lib/types";

import env from "@/env";
import { rateLimitBucket, resolveClientIp } from "@/lib/client-ip";
import { redis } from "@/lib/redis";

/**
 * Rate limiting (CLAUDE.md §7), ported from school-saas-api with two layers
 * it lacked:
 *
 *   - an in-memory FIRST layer: once a key is over its limit, this instance
 *     refuses it without asking Redis, so a flood costs no round trips;
 *   - an in-memory FALLBACK: if Redis is unreachable, counting carries on
 *     per instance instead of failing open everywhere at once.
 *
 * Redis is the shared count, so N instances do not allow N times the traffic.
 * Keys are a user id or an HMAC of an address or an email, never the value
 * itself (rule 10): a plain hash of an IPv4 address is reversible by trying
 * all four billion.
 */

/** Where a limit's key comes from. Return null to leave a request uncounted. */
export type KeySource = (c: Context<AppBindings>) => string | null | Promise<string | null>;

export interface RateLimitOptions {
  /** Requests allowed per window. */
  points: number;
  /** Window length in seconds. */
  duration: number;
  /** Namespaces the counters so groups don't share a budget. */
  keyPrefix: string;
  /** Defaults to the signed-in user, else the caller's address. */
  key?: KeySource;
  /** Overridable so the fallback path can be tested against an unreachable Redis. */
  client?: Redis;
}

/** Distinguishes "you are rate limited" from "the store broke". */
function isRateLimiterRes(err: unknown): err is RateLimiterRes {
  return typeof err === "object" && err !== null && "msBeforeNext" in err;
}

/** A keyed digest, so a stored key cannot be turned back into what it counts. */
function digest(kind: string, value: string) {
  return createHmac("sha256", env.BETTER_AUTH_SECRET).update(`rate-limit:${kind}:${value}`).digest("hex").slice(0, 32);
}

/** Parsed once: the allowlist cannot change without a restart. */
const trustedProxies = new Set(
  env.TRUSTED_PROXY_IPS?.split(",").map(ip => ip.trim()).filter(Boolean) ?? [],
);

/**
 * The caller's address bucket: from the socket, or from X-Forwarded-For only
 * as far as TRUST_PROXY_HOPS allows (lib/client-ip.ts), with an IPv6 address
 * counted by its /64.
 */
export const byAddress: KeySource = c => `ip:${digest("ip", rateLimitBucket(callerAddress(c) ?? "unknown"))}`;

/** The caller's address, as far as the configured proxies can be trusted to report it. */
export function callerAddress(c: Context<AppBindings>): string | undefined {
  let socketAddress: string | undefined;
  try {
    socketAddress = getConnInfo(c).remote.address;
  }
  catch {
    // No socket behind this request, e.g. app.request() in tests.
  }

  return resolveClientIp(
    { socketAddress, xForwardedFor: c.req.header("x-forwarded-for") },
    env.TRUST_PROXY_HOPS,
    trustedProxies,
  ) ?? undefined;
}

/** The signed-in user, else the address: one person behind a shared hospital connection cannot exhaust everyone's budget. */
export const byUserOrAddress: KeySource = c => c.var.user?.id ? `user:${c.var.user.id}` : byAddress(c);

/**
 * The account a sign-in names, from the JSON body. Counted whatever address
 * the attempts come from, so spreading a password guess across many
 * addresses does not multiply the guesses one account can take.
 */
export const bySignInEmail: KeySource = async (c) => {
  try {
    const body = await c.req.raw.clone().json() as { email?: unknown };
    if (typeof body.email !== "string" || !body.email)
      return null;
    return `email:${digest("email", body.email.trim().toLowerCase())}`;
  }
  catch {
    // Not JSON: Better Auth refuses it, and there is no account to count.
    return null;
  }
};

/**
 * The account a sign-in names, together with the address trying it. A
 * caller's wrong guesses use up their own budget for that account, not the
 * budget of its owner signing in from somewhere else.
 */
export const bySignInEmailFromAddress: KeySource = async (c) => {
  const account = await bySignInEmail(c);
  return account === null ? null : `${account}:${await byAddress(c)}`;
};

export function rateLimit(options: RateLimitOptions) {
  const limiter = new RateLimiterRedis({
    storeClient: options.client ?? redis,
    keyPrefix: `rl:${options.keyPrefix}`,
    points: options.points,
    duration: options.duration,
    // First layer: a key over its limit is refused locally until it expires.
    inMemoryBlockOnConsumed: options.points,
    inMemoryBlockDuration: options.duration,
    // Fallback: Redis down means this instance counts on its own.
    insuranceLimiter: new RateLimiterMemory({
      keyPrefix: `rl-mem:${options.keyPrefix}`,
      points: options.points,
      duration: options.duration,
    }),
  });
  const keyOf = options.key ?? byUserOrAddress;

  return createMiddleware<AppBindings>(async (c, next) => {
    const key = await keyOf(c);
    if (key === null)
      return next();

    try {
      await limiter.consume(key);
    }
    catch (err) {
      if (!isRateLimiterRes(err)) {
        // Both layers broke, which the memory fallback should make
        // impossible. Fail closed: these routes guard credentials.
        c.var.logger.error({ keyPrefix: options.keyPrefix }, "Rate limiter failed");
        return c.json({ message: "Please try again shortly." }, HttpStatusCodes.SERVICE_UNAVAILABLE);
      }

      const retryAfter = Math.max(1, Math.ceil(err.msBeforeNext / 1000));
      c.header("Retry-After", String(retryAfter));

      return c.json(
        {
          message: "Too many requests. Please slow down and try again shortly.",
          retryAfterSeconds: retryAfter,
        },
        HttpStatusCodes.TOO_MANY_REQUESTS,
      );
    }

    await next();
  });
}

/** Presets, so call sites read as intent rather than arithmetic. */
export const rateLimits = {
  /** Better Auth's POSTs (sign-in, password flows), per address: brute force and enumeration. */
  auth: () => rateLimit({ points: 10, duration: 60, keyPrefix: "auth", key: byAddress }),

  /** Sign-in attempts on one account from one address: the tight limit. */
  signInAccountFromAddress: () => rateLimit({ points: 10, duration: 900, keyPrefix: "signin-account-ip", key: bySignInEmailFromAddress }),

  /**
   * Sign-in attempts on one account from anywhere. Loose on purpose: it stops
   * a guess spread across many addresses, but a limit this tight on its own
   * would let anyone who knows a clinician's email keep them locked out from
   * one laptop. Reaching this one takes ten addresses or more.
   */
  signInAccount: () => rateLimit({ points: 100, duration: 900, keyPrefix: "signin-account", key: bySignInEmail }),

  /** Better Auth's GETs: a staff app checks its session constantly, so this only stops a flood. */
  authRead: () => rateLimit({ points: 300, duration: 60, keyPrefix: "auth-read", key: byAddress }),

  /**
   * Invitation acceptance: a token guess, or a password set, per attempt. By
   * address even for a signed-in caller, so a session does not double it.
   */
  invitation: () => rateLimit({ points: 10, duration: 900, keyPrefix: "invite", key: byAddress }),

  /**
   * Public document verification, per address. A 160-bit code cannot be
   * guessed, so this only bounds volume: a pharmacy checking a queue of
   * prescriptions stays well inside it.
   */
  verify: () => rateLimit({ points: 30, duration: 60, keyPrefix: "verify", key: byAddress }),

  /**
   * Patient search, per signed-in person (CLAUDE.md §7): a desk finds a few
   * patients a minute; a script trying names to copy out the register finds
   * many more, and stops here.
   */
  patientSearch: () => rateLimit({ points: 60, duration: 60, keyPrefix: "patient-search", key: byUserOrAddress }),

  /**
   * Invitations sent, per facility admin. Each one is an email from our
   * domain, so this caps mail-bombing through a compromised admin account.
   */
  invitationsSent: () => rateLimit({ points: 50, duration: 3600, keyPrefix: "invite-send", key: byUserOrAddress }),
};
