import { describe, expect, it } from "vitest";

import { businessDate, printedDateTime } from "./dates";

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

describe("printedDateTime", () => {
  it.each([
    // Printed in Kenyan time: the new year has begun in Nairobi.
    ["2026-12-31T22:30:00Z", "1 Jan 2027, 01:30"],
    ["2026-11-04T09:05:00Z", "4 Nov 2026, 12:05"],
    // A 24-hour clock, with midnight as 00.
    ["2026-11-04T21:00:00Z", "5 Nov 2026, 00:00"],
  ])("prints %s as %s", (instant, expected) => {
    expect(printedDateTime(new Date(instant))).toBe(expected);
  });
});
