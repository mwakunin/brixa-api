import { describe, expect, it } from "vitest";

import { MAX_NOTES, NOTE_LENGTH, packNotes } from "./document-content";

/** Notes on a printed document: packed whole into the notes it holds, never cut. */

describe("packNotes", () => {
  it("joins short lines into one note", () => {
    expect(packNotes(["One.", "Two."])).toEqual(["One.; Two."]);
  });

  it("starts a new note rather than cut a line", () => {
    const line = "x".repeat(600);

    expect(packNotes([line, line, "short"])).toEqual([line, `${line}; short`]);
  });

  it("refuses what cannot be printed whole: a line too long, or too many notes", () => {
    expect(packNotes(["x".repeat(NOTE_LENGTH + 1)])).toBeNull();
    expect(packNotes(Array.from({ length: MAX_NOTES + 1 }, () => "x".repeat(NOTE_LENGTH)))).toBeNull();
    expect(packNotes(Array.from({ length: MAX_NOTES }, () => "x".repeat(NOTE_LENGTH)))).toHaveLength(MAX_NOTES);
  });
});
