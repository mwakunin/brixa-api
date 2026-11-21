import { describe, expect, it } from "vitest";

import { ONE_LINE } from "./validation";

describe("one line of text", () => {
  it.each([
    ["a newline", "P.O. Box 120\nNakuru"],
    ["a line separator", "P.O. Box 120\u2028Nakuru"],
    ["a paragraph separator", "P.O. Box 120\u2029Nakuru"],
    ["a direction override", "A\u202Ereversed"],
    ["a zero-width joiner", "Otie\u200Dno"],
  ])("refuses %s", (_label, text) => {
    expect(ONE_LINE.test(text)).toBe(false);
  });

  it("takes ordinary text, spaces and punctuation included, in any script", () => {
    for (const text of ["P.O. Box 120-20100, Nakuru", "Wanjiru Kamau", "Fièvre et toux", "Ðurđević"])
      expect(ONE_LINE.test(text)).toBe(true);
  });
});
