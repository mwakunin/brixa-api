import { and, asc, desc, eq, isNull, like, or, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { icdCodes } from "@/db/schema";

/**
 * Finding an ICD-11 code by what a clinician types (SPEC.md §7.9: diagnoses
 * are searched by name; codes are shown, not required). Each word typed
 * matches the start of a word in the title, so "falc mal" finds "Malaria due
 * to Plasmodium falciparum"; a code, or its start, matches the code.
 *
 * Only leaves of chapters 01–25 that the current release still has: a code
 * with children is too broad to record. No patient data is involved, so the
 * search is not audited.
 */

/** As many as a pick list needs: the next keystroke narrows it. */
const SEARCH_LIMIT = 20;

/** The expression `icd_codes_title_search` indexes (migration 0049); it must match exactly. */
const titleVector = sql`to_tsvector('simple', ${icdCodes.title})`;

export type IcdCode = typeof icdCodes.$inferSelect;

/** A code a search finds, as a pick list shows it. */
export interface IcdMatch {
  code: string;
  title: string;
  uri: string;
  residual: boolean;
}

export async function searchIcd(tx: AppDb, q: string): Promise<IcdMatch[]> {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0)
    return [];
  // Letters and digits only reach the query, so nothing typed is tsquery syntax.
  const query = sql`to_tsquery('simple', ${words.map(w => `${w}:*`).join(" & ")})`;
  const typed = q.trim().toUpperCase();
  const codeLike = /^[0-9A-Z]{1,4}(?:\.[0-9A-Z]{0,2})*$/.test(typed) ? typed : null;

  return tx
    .select({ code: icdCodes.code, title: icdCodes.title, uri: icdCodes.uri, residual: icdCodes.isResidual })
    .from(icdCodes)
    .where(and(
      isNull(icdCodes.retiredAt),
      eq(icdCodes.isLeaf, true),
      or(sql`${titleVector} @@ ${query}`, codeLike ? like(icdCodes.code, `${codeLike}%`) : undefined),
    ))
    .orderBy(
      desc(sql`${icdCodes.code} = ${codeLike ?? ""}`),
      desc(sql`ts_rank(${titleVector}, ${query})`),
      asc(sql`length(${icdCodes.title})`),
      asc(icdCodes.code),
    )
    .limit(SEARCH_LIMIT);
}

/** The code as loaded, or null. Whether a diagnosis may name it (current, a leaf) is the caller's check. */
export async function codableIcd(tx: AppDb, code: string): Promise<IcdCode | null> {
  const [found] = await tx.select().from(icdCodes).where(eq(icdCodes.code, code)).limit(1);
  return found ?? null;
}
