import type { Context, MiddlewareHandler } from "hono";
import type { Redis } from "ioredis";

import { createMiddleware } from "hono/factory";
import { RateLimiterMemory, RateLimiterRedis } from "rate-limiter-flexible";
import * as HttpStatusCodes from "stoker/http-status-codes";

import type { AppBindings } from "@/lib/types";

import { auth } from "@/lib/auth";
import { redis } from "@/lib/redis";
import { noteSignInEvent } from "@/lib/sign-in-log";

import { bySignInEmailFromAddress } from "./rate-limit";

/** Wrong passwords in a row that lock an account from one address. */
export const LOCK_AFTER = 5;
/** How long that lasts, from the wrong password that set it. */
export const LOCK_SECONDS = 15 * 60;

/** The account a sign-in names, if there is one: the event is filed under it. */
async function accountNamed(email: string | null): Promise<string | null> {
  if (!email)
    return null;
  const found = await (await auth.$context).internalAdapter.findUserByEmail(email);
  return found?.user.id ?? null;
}

async function emailOf(c: Context<AppBindings>): Promise<string | null> {
  try {
    const body = await c.req.raw.clone().json() as { email?: unknown };
    return typeof body.email === "string" && body.email ? body.email.trim().toLowerCase() : null;
  }
  catch {
    return null;
  }
}

/**
 * Locks an account after five wrong passwords in a row (regulation 12;
 * DHA's certification framework asks for accounts locked after repeated
 * wrong passwords), for 15 minutes, and logs the lock.
 *
 * Counted per account and address, as the tight sign-in limit is
 * (middlewares/rate-limit.ts): someone who knows a clinician's email can
 * lock that account from their own address, and not lock the clinician out
 * at their desk. The loose per-account limit still caps a guess spread across
 * many addresses. A right password clears the count, so it counts wrong
 * passwords in a row. While locked, even the right password is refused,
 * before Better Auth checks it, and the answer is the same whether or not
 * the account exists.
 */
export function signInLock(client?: Redis): MiddlewareHandler<AppBindings> {
  const limiter = new RateLimiterRedis({
    storeClient: client ?? redis,
    keyPrefix: "rl:signin-lock",
    points: LOCK_AFTER,
    duration: LOCK_SECONDS,
    // Redis down: this instance counts on its own rather than stopping counting.
    insuranceLimiter: new RateLimiterMemory({ keyPrefix: "rl-mem:signin-lock", points: LOCK_AFTER, duration: LOCK_SECONDS }),
  });

  return createMiddleware<AppBindings>(async (c, next) => {
    const key = await bySignInEmailFromAddress(c);
    if (key === null)
      return next();
    // Read now: Better Auth consumes the body.
    const email = await emailOf(c);

    const counted = await limiter.get(key);
    if (counted && counted.consumedPoints >= LOCK_AFTER) {
      await noteSignInEvent({ event: "refused_locked", userId: await accountNamed(email), factor: "password" });
      const retryAfter = Math.max(1, Math.ceil(counted.msBeforeNext / 1000));
      c.header("Retry-After", String(retryAfter));
      return c.json(
        {
          message: "Too many wrong passwords for this account. Signing in to it from here is stopped for 15 minutes.",
          code: "sign_in_locked",
          retryAfterSeconds: retryAfter,
        },
        HttpStatusCodes.TOO_MANY_REQUESTS,
      );
    }

    await next();

    if (c.res.status === HttpStatusCodes.UNAUTHORIZED) {
      const after = await limiter.penalty(key, 1);
      if (after.consumedPoints === LOCK_AFTER) {
        await limiter.block(key, LOCK_SECONDS);
        await noteSignInEvent({ event: "locked", userId: await accountNamed(email), factor: "password" });
      }
    }
    else if (c.res.ok) {
      await limiter.delete(key);
    }
  });
}
