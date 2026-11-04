import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";

import { REDACTED_PATHS } from "./pino-logger";

/**
 * The redaction paths are strings pino interprets, so a typo is not an error,
 * it is a credential written to the log. This proves each path matches the
 * shape it is meant for.
 */
describe("log redaction", () => {
  it("removes session cookies and authorization headers before writing", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const logger = pino({ redact: { paths: REDACTED_PATHS, censor: "[redacted]" } }, sink);

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
