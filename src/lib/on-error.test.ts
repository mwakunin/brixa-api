import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";

import { createRouter, createTestApp } from "@/lib/create-app";

import { errorLine, summarizeError } from "./error-summary";

/** What Drizzle's errors look like: the SQL, then every bound value. */
const QUERY_ERROR = "Failed query: insert into \"invitations\" (\"email\") values ($1)\nparams: secret.person@example.test";

const router = createRouter();
router.get("/boom", () => {
  throw new Error(QUERY_ERROR);
});
router.get("/refused", () => {
  throw new HTTPException(403, { message: "Not for you" });
});
const app = createTestApp(router);

describe("the error handler", () => {
  it("answers an unhandled error with a fixed message and the request id, never its text", async () => {
    const res = await app.request("/boom");

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("secret.person");
    expect(text).not.toContain("Failed query");
    expect(JSON.parse(text)).toEqual({ message: "Internal Server Error", requestId: expect.any(String) });
  });

  it("keeps a deliberate refusal's own status and message", async () => {
    const res = await app.request("/refused");

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Not for you");
  });
});

describe("error summaries", () => {
  it("keeps the query but drops its parameters", () => {
    const summary = summarizeError(new Error(QUERY_ERROR));

    expect(summary.message).toBe("Failed query: insert into \"invitations\" (\"email\") values ($1)");
    expect(errorLine(new Error(QUERY_ERROR))).not.toContain("secret.person");
  });

  it("keeps the SQLSTATE and constraint a database error carries", () => {
    const err = Object.assign(new Error("duplicate key"), { code: "23505", constraint: "invitations_one_pending_per_email" });

    expect(summarizeError(err)).toEqual({
      name: "Error",
      message: "duplicate key",
      code: "23505",
      constraint: "invitations_one_pending_per_email",
    });
  });
});
