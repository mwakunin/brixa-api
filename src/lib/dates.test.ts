import { describe, expect, it } from "vitest";

import { businessDate } from "./dates";

describe("businessDate", () => {
  it.each([
    // 01:00 in Nairobi on the 1st is still 22:00 UTC on the previous day.
    ["2026-12-31T22:00:00Z", "2027-01-01"],
    ["2026-08-31T21:00:00Z", "2026-09-01"],
    // 20:59 UTC is still the same Kenyan day.
    ["2026-08-31T20:59:00Z", "2026-08-31"],
    ["2026-09-01T09:00:00Z", "2026-09-01"],
  ])("at %s the Kenyan calendar day is %s", (instant, expected) => {
    expect(businessDate(new Date(instant))).toBe(expected);
  });

  it("always produces a zero-padded YYYY-MM-DD", () => {
    expect(businessDate(new Date("2026-02-03T12:00:00Z"))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
