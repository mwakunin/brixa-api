import type { MiddlewareHandler } from "hono";

/**
 * Holds the response until `ms` have passed since the request arrived, so the
 * time an answer takes says nothing about the work behind it. A request for a
 * password reset emails a link only when the address has an account; without
 * this, the wait for the email provider would tell a stranger which
 * addresses belong to staff. Work that runs longer than `ms` is not cut
 * short, so the work behind the route must be bounded well inside it (the
 * reset email's wait is, in lib/auth.ts).
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
