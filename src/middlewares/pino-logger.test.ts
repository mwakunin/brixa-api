import { Hono } from "hono";
import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";

import type { AppBindings } from "@/lib/types";

import { onError } from "@/lib/on-error";

import { pinoLogger, REDACTED_PATHS } from "./pino-logger";

/** A pino logger whose output a test can read. */
function capturingLogger() {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { lines, logger: pino({ redact: { paths: REDACTED_PATHS, censor: "[redacted]" } }, sink) };
}

/**
 * The redaction paths are strings pino interprets, so a typo is not an error,
 * it is a credential written to the log. This proves each path matches the
 * shape it is meant for.
 */
describe("log redaction", () => {
  it("removes session cookies and authorization headers before writing", () => {
    const { lines, logger } = capturingLogger();

    logger.info({
      req: { headers: { "cookie": "better-auth.session_token=abc", "authorization": "Bearer xyz", "user-agent": "kept" } },
      res: { headers: { "set-cookie": "better-auth.session_token=def" } },
    }, "request");

    const written = lines.join("");
    expect(written).not.toContain("abc");
    expect(written).not.toContain("xyz");
    expect(written).not.toContain("def");
    expect(written).toContain("kept");
  });
});

describe("a request's logged path", () => {
  it("never carries an M-Pesa callback token", async () => {
    const { lines, logger } = capturingLogger();
    const token = "a".repeat(43);
    const app = new Hono<AppBindings>()
      .use(pinoLogger(logger))
      .post("/webhooks/mpesa/:token/c2b/confirmation", c => c.json({ ResultCode: 0 }));

    await app.request(`/webhooks/mpesa/${token}/c2b/confirmation`, { method: "POST" });

    const written = lines.join("");
    expect(written).toContain("/webhooks/mpesa/[token]/c2b/confirmation");
    expect(written).not.toContain(token);
  });
});

describe("a failed request's log lines", () => {
  // What Drizzle's errors look like: the SQL, then every bound value.
  const QUERY_ERROR = "Failed query: insert into \"invitations\" (\"email\", \"name\") values ($1, $2)\nparams: secret.person@example.test,Wanjiru Kamau";

  it("carry neither the query's values nor the error's text (rule 10)", async () => {
    const { lines, logger } = capturingLogger();
    const app = new Hono<AppBindings>()
      .use(pinoLogger(logger))
      .get("/boom", () => {
        throw new Error(QUERY_ERROR);
      })
      .onError(onError);

    const res = await app.request("/boom");

    expect(res.status).toBe(500);
    const written = lines.join("");
    expect(written).toContain("Request failed");
    expect(written).not.toContain("secret.person");
    expect(written).not.toContain("Wanjiru");
  });
});
