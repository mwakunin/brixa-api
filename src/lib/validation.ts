import { z } from "@hono/zod-openapi";

/**
 * Text that ends up in an email from our domain.
 *
 * An invitation names its recipient and its facility, so whoever writes those
 * fields writes part of a genuine, platform-sent message carrying a real link.
 * One short line with no control or invisible characters (`\p{C}`: newlines,
 * zero-width joiners, direction overrides) keeps it a name rather than a
 * paragraph of someone else's text.
 */
function displayText(max: number) {
  return z.string().trim().min(2).max(max).regex(/^\P{C}+$/u, "One line, without control characters");
}

/** A person's name as staff will see it. */
export const personNameSchema = displayText(100);

/** A facility's name, which also heads every invitation it sends. */
export const facilityNameSchema = displayText(200);
