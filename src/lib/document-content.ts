import { z } from "zod";

/**
 * What a printed document says, frozen when it is issued (CLAUDE.md rule 7).
 *
 * Presentation, not domain data: every value is the text as printed, already
 * formatted ("KES 1,500.00", "4 Nov 2026"). The module that issues a document
 * builds this from its own rows at finalisation, and the PDF is rendered from
 * it and nothing else, so a later price, name or formatting change cannot
 * alter a document already in someone's hand. The structured data stays in
 * the issuing module's own tables.
 *
 * Kept free of database imports so `db/schema.ts` can type the column with it.
 */

const label = z.string().trim().min(1).max(60);
/** How long a field's or a total's value may be. */
export const FIELD_LENGTH = 500;
const printed = z.string().max(FIELD_LENGTH);
/** A table cell: a lab report prints a text result of up to 2,000 characters whole. */
const cell = z.string().max(2000);

/** The notes a document holds, and how long each may be. */
export const MAX_NOTES = 50;
export const NOTE_LENGTH = 1000;

/**
 * Lines packed into as few notes as hold them, joined with "; ", a line
 * never cut nor split: null when they cannot all be printed whole (a line
 * longer than `length`, or more notes than a document holds), for the caller
 * to refuse rather than print part.
 */
export function packNotes(lines: string[], length = NOTE_LENGTH): string[] | null {
  const notes: string[] = [];
  for (const line of lines) {
    if (line.length > length)
      return null;
    const last = notes.at(-1);
    if (last !== undefined && last.length + 2 + line.length <= length)
      notes[notes.length - 1] = `${last}; ${line}`;
    else
      notes.push(line);
  }
  return notes.length > MAX_NOTES ? null : notes;
}

const lineSchema = z.object({ label, value: printed });

const tableSchema = z.object({
  columns: z.array(z.object({
    label,
    align: z.enum(["left", "right"]).default("left"),
  })).min(1).max(8),
  // A lab report runs to an order's tests times their analytes (30 × 60, lib/lab-results.ts).
  rows: z.array(z.array(cell)).max(2000),
}).refine(
  table => table.rows.every(row => row.length === table.columns.length),
  "Every row needs one cell per column",
);

/** What the issuing module supplies. */
export const printedContentSchema = z.object({
  /** The document's heading, e.g. "Receipt". */
  title: z.string().trim().min(1).max(80),
  /** Label and value pairs under the heading: who, which account, how paid. */
  fields: z.array(lineSchema).max(30).default([]),
  table: tableSchema.optional(),
  /** Right-aligned under the table: subtotal, paid, balance. */
  totals: z.array(lineSchema).max(10).default([]),
  notes: z.array(z.string().max(NOTE_LENGTH)).max(MAX_NOTES).default([]),
});

export type PrintedContent = z.input<typeof printedContentSchema>;

/**
 * The facility as it was named when the document was issued. Added by
 * `issueDocument`, never by the caller, so no module can print another
 * facility's name.
 */
const issuerSchema = z.object({
  name: z.string(),
  kmhfrCode: z.string(),
  county: z.string().nullable(),
});

/** What is stored: the supplied content plus the issuer. */
export const documentContentSchema = printedContentSchema.extend({ issuer: issuerSchema });

export type DocumentContent = z.output<typeof documentContentSchema>;
