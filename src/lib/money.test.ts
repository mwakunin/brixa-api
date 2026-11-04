import { describe, expect, it } from "vitest";

import { chargeAmountCents, formatKes, printedQuantity } from "./money";

describe("a charge's amount", () => {
  it.each([
    ["1", 50_000, 50_000],
    ["3", 250, 800],
    ["2", 250, 500],
    ["1.5", 333, 500],
    ["0.25", 120_000, 30_000],
    ["1", 249, 200],
    ["1", 250, 300],
    ["1", 0, 0],
    ["0.001", 1, 0],
  ])("is %s × %i cents, rounded half up to whole shillings: %i", (quantity, unit, amount) => {
    expect(chargeAmountCents(quantity, unit)).toBe(amount);
  });

  it("stays exact at the largest charge it allows", () => {
    expect(chargeAmountCents("4000", 500_000)).toBe(2_000_000_000);
  });

  it("refuses a charge larger than a charge can hold", () => {
    expect(() => chargeAmountCents("4001", 500_000)).toThrow(RangeError);
  });

  it.each(["", "-1", "1.2345", "01", "1e3", "abc"])("refuses the quantity %j", (quantity) => {
    expect(() => chargeAmountCents(quantity, 100)).toThrow(RangeError);
  });
});

describe("printed money", () => {
  it.each([
    [0, "KES 0.00"],
    [250, "KES 2.50"],
    [50_000, "KES 500.00"],
    [150_000_000, "KES 1,500,000.00"],
    [-12_345_600, "-KES 123,456.00"],
  ])("prints %i cents as %s", (cents, expected) => {
    expect(formatKes(cents)).toBe(expected);
  });

  it.each([["1.000", "1"], ["1.500", "1.5"], ["0.250", "0.25"], ["10", "10"], ["100.000", "100"]])("prints the quantity %s as %s", (quantity, expected) => {
    expect(printedQuantity(quantity)).toBe(expected);
  });
});
