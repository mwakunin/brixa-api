import type { MiddlewareHandler } from "hono";

/**
 * Holds the response until `ms` have passed since the request arrived, so the
 * time an answer takes says nothing about the work behind it. A request for a
 * password reset writes a link only when the address has an account. Work
 * that runs longer than `ms` is not cut short, so a route behind this keeps
 * slow outside calls out of its answer: the reset email is sent without being
 * awaited (lib/auth.ts), and the database work is short on both paths.
 */
export function answerNoSoonerThan(ms: number): MiddlewareHandler {
  return async (_c, next) => {
    const arrived = performance.now();
    await next();
    const left = ms - (performance.now() - arrived);
    if (left > 0)
      await new Promise(resolve => setTimeout(resolve, left));
  };
}
