import { and, isNull, ne, sql } from "drizzle-orm";

import db from "@/db";
import { icdCodes } from "@/db/schema";

/**
 * Loads WHO's ICD-11 MMS release into `icd_codes` (SPEC.md §4, question 8).
 *
 * The input is WHO's "simple tabulation" file, as downloaded from the ICD-11
 * browser (Info → spreadsheet) or
 * `https://icdcdn.who.int/static/releasefiles/<release>/SimpleTabulation-ICD-11-MMS-en.zip`:
 * the `.txt` inside, unmodified. Its layout, as of the 2026-01 release:
 *
 *   - UTF-8 with a byte-order mark; records end with CRLF; fields are
 *     tab-separated.
 *   - A field may be "quoted", with "" for a quote inside. A coding note may
 *     hold bare line feeds unquoted; no field holds a tab or a CRLF.
 *   - Titles carry "- " depth markers, which are layout, not WHO's title.
 *   - The last header column names the version: `Version:2026 Jan 17 - ...`.
 *
 * Only categories in chapters 01–25 are kept (see `icd_codes`). The file is
 * read whole and loaded in one transaction, so a failure leaves the table as
 * it was. A code absent from a newer release is marked retired, never
 * deleted: past diagnoses name it. Run by `pnpm icd11:load`, on the OWNER
 * connection, because the app role may only read shared reference data
 * (CLAUDE.md rule 1).
 *
 * WHO's licence (CC BY-ND 3.0 IGO) permits this provided the code, title and
 * URI stay together and the classification is not altered: titles are kept
 * as WHO wrote them, the depth markers aside.
 */

export class IcdFileError extends Error {
  constructor(message: string) {
    super(`Not a usable ICD-11 MMS tabulation: ${message}`);
    this.name = "IcdFileError";
  }
}

export interface IcdRow {
  code: string;
  title: string;
  uri: string;
  chapter: string;
  isLeaf: boolean;
  isResidual: boolean;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CODE_SHAPE = /^[0-9A-Z]{4}(?:\.[0-9A-Z]{1,2})*$/;
const DIAGNOSIS_CHAPTERS = /^(?:0[1-9]|1\d|2[0-5])$/;
const NEEDED = ["Linearization URI", "Code", "Title", "ClassKind", "IsResidual", "ChapterNo", "isLeaf"] as const;
const BATCH = 1000;

function unquote(field: string): string {
  return field.length >= 2 && field.startsWith("\"") && field.endsWith("\"")
    ? field.slice(1, -1).replaceAll("\"\"", "\"")
    : field;
}

/** `Version:2026 Jan 17 - 05:30 UTC` → `2026-01`. */
function releaseOf(header: string[]): string {
  const version = header.find(h => h.startsWith("Version:"));
  const match = version?.match(/^Version:(\d{4}) ([A-Z][a-z]{2})\b/);
  const month = match ? MONTHS.indexOf(match[2]) + 1 : 0;
  if (!match || month === 0)
    throw new IcdFileError("no Version column naming the release");
  return `${match[1]}-${String(month).padStart(2, "0")}`;
}

/** The categories of chapters 01–25, and the release they come from. */
export function parseMmsTabulation(text: string): { release: string; rows: IcdRow[] } {
  const records = text.replace(/^\uFEFF/, "").split("\r\n").filter(r => r.length > 0);
  if (records.length < 2)
    throw new IcdFileError("no records");

  const header = records[0].split("\t").map(unquote);
  const at = Object.fromEntries(NEEDED.map((name) => {
    const index = header.indexOf(name);
    if (index < 0)
      throw new IcdFileError(`no "${name}" column`);
    return [name, index];
  })) as Record<(typeof NEEDED)[number], number>;
  const release = releaseOf(header);

  const rows: IcdRow[] = [];
  for (const [n, record] of records.slice(1).entries()) {
    const f = record.split("\t").map(unquote);
    if (f.length < header.length - 1)
      throw new IcdFileError(`record ${n + 2} has ${f.length} fields`);
    if (f[at.ClassKind] !== "category" || !DIAGNOSIS_CHAPTERS.test(f[at.ChapterNo]))
      continue;

    const row: IcdRow = {
      code: f[at.Code],
      title: f[at.Title].replace(/^(?:- )+/, "").trim(),
      uri: f[at["Linearization URI"]],
      chapter: f[at.ChapterNo],
      isLeaf: f[at.isLeaf] === "True",
      isResidual: f[at.IsResidual] === "True",
    };
    if (!CODE_SHAPE.test(row.code) || !row.title || !row.uri.startsWith("http://id.who.int/icd/release/11/"))
      throw new IcdFileError(`record ${n + 2} (${row.code}) is not a coded category`);
    rows.push(row);
  }

  if (rows.length === 0)
    throw new IcdFileError("no categories in chapters 01–25");
  return { release, rows };
}

/**
 * Loads a release, replacing what each code says and retiring the codes it
 * no longer has. Refuses a release older than one already loaded.
 */
export async function loadIcd11(text: string, owner = db): Promise<{ release: string; loaded: number; retired: number }> {
  const { release, rows } = parseMmsTabulation(text);

  return owner.transaction(async (tx) => {
    // One load at a time; a second waits, then sees the first's release.
    await tx.execute(sql`LOCK TABLE ${icdCodes} IN SHARE ROW EXCLUSIVE MODE`);
    const [newest] = await tx.select({ release: sql<string | null>`max(${icdCodes.release})` }).from(icdCodes);
    if (newest.release && newest.release > release)
      throw new IcdFileError(`release ${release} is older than ${newest.release}, already loaded`);

    for (let i = 0; i < rows.length; i += BATCH) {
      await tx.insert(icdCodes)
        .values(rows.slice(i, i + BATCH).map(r => ({ ...r, release, retiredAt: null })))
        .onConflictDoUpdate({
          target: icdCodes.code,
          set: {
            title: sql`excluded.title`,
            uri: sql`excluded.uri`,
            chapter: sql`excluded.chapter`,
            isLeaf: sql`excluded.is_leaf`,
            isResidual: sql`excluded.is_residual`,
            release: sql`excluded.release`,
            retiredAt: sql`NULL`,
          },
        });
    }

    const retired = await tx.update(icdCodes)
      .set({ retiredAt: new Date() })
      .where(and(ne(icdCodes.release, release), isNull(icdCodes.retiredAt)))
      .returning({ code: icdCodes.code });

    return { release, loaded: rows.length, retired: retired.length };
  });
}
