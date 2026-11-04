import { describe, expect, it } from "vitest";

import { normalizePhone } from "./phone";

describe("normalizePhone", () => {
  it.each([
    "0712345678",
    "+254712345678",
    "254712345678",
    "712345678",
    "0712 345 678",
    "(0712)-345-678",
    "+254 712 345 678",
  ])("stores %s as one Kenyan number", (input) => {
    expect(normalizePhone(input)).toBe("+254712345678");
  });

  it("accepts the newer 011x range", () => {
    expect(normalizePhone("0110123456")).toBe("+254110123456");
  });

  it("is idempotent", () => {
    expect(normalizePhone(normalizePhone("0712345678")!)).toBe("+254712345678");
  });

  it("keeps a foreign number typed with its country code", () => {
    expect(normalizePhone("+256 772 123456")).toBe("+256772123456");
  });

  it.each([
    "",
    "not a number",
    "0712",
    "0812345678",
    "07123456789",
    "+0712345678",
    "772123456789",
  ])("refuses %j", (input) => {
    expect(normalizePhone(input)).toBeNull();
  });
});
