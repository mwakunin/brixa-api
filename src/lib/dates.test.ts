import { describe, expect, it } from "vitest";

import { addDays, ageInYears, businessDate, dateOfBirthForAge, printedDate, printedDateTime, startOfBusinessDay } from "./dates";

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

describe("business days in Kenya", () => {
  it("move by whole days across months and years", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it.each(["2026-01-01", "2026-06-30", "2026-11-04"])("begin at Nairobi's midnight: %s", (date) => {
    const start = startOfBusinessDay(date);

    expect(businessDate(start)).toBe(date);
    expect(businessDate(new Date(start.getTime() - 1))).toBe(addDays(date, -1));
  });
});

describe("ages", () => {
  it.each([
    ["2000-11-04", "2026-11-04", 26],
    ["2000-11-05", "2026-11-04", 25],
    ["2026-01-01", "2026-11-04", 0],
    ["2008-02-29", "2026-02-28", 17],
    ["2008-02-29", "2026-03-01", 18],
  ])("someone born %s is, on %s, %i", (dob, today, age) => {
    expect(ageInYears(dob, today)).toBe(age);
  });

  it("turns a stated age into the date of birth it implies", () => {
    expect(dateOfBirthForAge(30, "2026-11-04")).toBe("1996-11-04");
    expect(dateOfBirthForAge(0, "2026-11-04")).toBe("2026-11-04");
    // No 29 February in 2025.
    expect(dateOfBirthForAge(3, "2028-02-29")).toBe("2025-02-28");
  });

  it("round-trips: the implied date gives back the stated age", () => {
    expect(ageInYears(dateOfBirthForAge(42, "2026-11-04"), "2026-11-04")).toBe(42);
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

describe("printedDate", () => {
  it.each([["2026-11-04", "4 Nov 2026"], ["2027-01-01", "1 Jan 2027"], ["2026-12-31", "31 Dec 2026"]])("prints %s as %s", (date, expected) => {
    expect(printedDate(date)).toBe(expected);
  });
});
