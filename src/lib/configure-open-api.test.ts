import { describe, expect, it } from "vitest";

import { withKeyReuseNamed, withPlainPatterns } from "./configure-open-api";

describe("patterns in the API description", () => {
  it("drops a /u flag, leaves out a pattern with another flag, and keeps the rest as it was", () => {
    const doc = {
      properties: {
        address: { type: "string", maxLength: 200, pattern: "^[^\\p{C}]+$/u" },
        paybill: { type: "string", maxLength: 12, pattern: "^[A-Z0-9/-]{1,12}$/i" },
        time: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" },
      },
      required: ["address"],
    };

    expect(withPlainPatterns(doc)).toEqual({
      properties: {
        address: { type: "string", maxLength: 200, pattern: "^[^\\p{C}]+$" },
        paybill: { type: "string", maxLength: 12 },
        time: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" },
      },
      required: ["address"],
    });
  });

  it("finds the flags whether or not the pattern is anchored, and never takes an escaped slash for them", () => {
    const flagged = (pattern: string) => withPlainPatterns({ pattern });

    // As zod-to-openapi writes /\p{L}+/u, /\p{L}+/i and /\\/u (one backslash).
    expect(flagged("\\p{L}+/u")).toEqual({ pattern: "\\p{L}+" });
    expect(flagged("[a-z]+/i")).toEqual({});
    expect(flagged("\\\\/u")).toEqual({ pattern: "\\\\" });
    // A source writes a slash it matches as \/, so this is "a/u" itself, with no flags.
    expect(flagged("a\\/u")).toEqual({ pattern: "a\\/u" });
  });
});

describe("a tenant write's 409 in the API description", () => {
  const facility = { in: "header", name: "x-facility-id" };
  const doc = {
    paths: {
      "/encounters": {
        post: { parameters: [facility], responses: { 409: { description: "Not possible in the encounter's current state" } } },
        get: { parameters: [facility], responses: { 200: { description: "Encounters" } } },
      },
      "/staff/invitations/{id}/revoke": {
        post: { parameters: [facility], responses: { 409: { description: "An Idempotency-Key already used for another request (`idempotency_key_reused`)" } } },
      },
      "/invitations/accept": {
        post: { parameters: [], responses: { 409: { description: "Accepted already" } } },
      },
    },
  };

  it("names the reused key beside the route's own conflict", () => {
    expect(withKeyReuseNamed(doc).paths["/encounters"].post.responses[409].description)
      .toBe("Not possible in the encounter's current state; or an Idempotency-Key already sent with another request (`idempotency_key_reused`)");
  });

  it("leaves a 409 that names it already, a read, and a write outside any facility as they were", () => {
    const named = withKeyReuseNamed(doc).paths;

    expect(named["/staff/invitations/{id}/revoke"]).toEqual(doc.paths["/staff/invitations/{id}/revoke"]);
    expect(named["/encounters"].get).toEqual(doc.paths["/encounters"].get);
    expect(named["/invitations/accept"]).toEqual(doc.paths["/invitations/accept"]);
  });
});
