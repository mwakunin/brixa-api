import { describe, expect, it } from "vitest";

import { withPlainPatterns } from "./configure-open-api";

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
});
