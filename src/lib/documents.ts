import { and, eq, isNull } from "drizzle-orm";

import type { AppDb } from "@/db";
import type { MembershipRole } from "@/db/schema";

import { documents, facilities } from "@/db/schema";

import type { PrintedContent } from "./document-content";

import { recordAudit } from "./audit";
import { documentContentSchema, printedContentSchema } from "./document-content";
import { issueNumber } from "./number-series";
import { mintVerificationCode } from "./verification";

/**
 * Printed documents (SCHEMA.md §6.2): issued once, frozen, voided at most once.
 *
 * Every function takes the caller's transaction. Issuing belongs inside the
 * transaction that finalises what the document records (a payment for a
 * receipt), so the number, the frozen content and the business change commit
 * together or not at all (rule 20).
 */

export type IssuedDocument = typeof documents.$inferSelect;
export type DocumentKind = IssuedDocument["kind"];

/** Who issued or voided a document: the person, and their membership here (rule 25). */
export interface DocumentActor {
  userId: string;
  membershipId: string;
}

/**
 * Who may open each kind of document. Opening one is a read of what it
 * records, and is audited as one (rule 9).
 */
export const DOCUMENT_READERS: Record<DocumentKind, readonly MembershipRole[]> = {
  receipt: ["cashier", "billing_clerk", "finance_manager", "facility_admin", "auditor"],
};

export function mayRead(roles: readonly MembershipRole[], kind: DocumentKind): boolean {
  return roles.some(role => DOCUMENT_READERS[kind].includes(role));
}

export class DocumentVoidError extends Error {
  constructor(readonly code: "not_found" | "already_voided") {
    super(code === "not_found" ? "No such document" : "This document is already voided");
    this.name = "DocumentVoidError";
  }
}

/**
 * Issues a document: takes its number, mints its verification code and
 * freezes what it says, with the facility's name as it is now.
 *
 * The content is validated here because a malformed one is a programming
 * error in the issuing module, and it must fail before a number is spent.
 */
export async function issueDocument(
  tx: AppDb,
  input: {
    facilityId: string;
    kind: DocumentKind;
    content: PrintedContent;
    /** Null when the system issues it with nobody asking. */
    issuedBy: DocumentActor | null;
    at?: Date;
  },
): Promise<IssuedDocument> {
  const printed = printedContentSchema.parse(input.content);

  const [issuer] = await tx
    .select({ name: facilities.name, kmhfrCode: facilities.kmhfrCode, county: facilities.county })
    .from(facilities)
    .where(eq(facilities.id, input.facilityId))
    .limit(1);
  if (!issuer)
    throw new Error("issueDocument: the facility is not visible in this transaction");

  const at = input.at ?? new Date();
  const number = await issueNumber(tx, input.facilityId, input.kind, at);
  const content = documentContentSchema.parse({ ...printed, issuer });

  const [document] = await tx
    .insert(documents)
    .values({
      facilityId: input.facilityId,
      kind: input.kind,
      number,
      verificationCode: mintVerificationCode(),
      content,
      issuedAt: at,
      issuedBy: input.issuedBy?.membershipId ?? null,
    })
    .returning();

  await recordAudit(tx, {
    facilityId: input.facilityId,
    actorId: input.issuedBy?.userId ?? null,
    action: "document.issued",
    entityType: "document",
    entityId: document.id,
    summary: `${content.title} ${number} issued`,
    detail: { kind: input.kind, number },
  });

  return document;
}

/**
 * Voids a document. It keeps its number and its content; the PDF then prints
 * VOID across it, and the verify page answers that it was withdrawn. Called
 * by the module whose own correction made it untrue (a reversed payment), in
 * the same transaction as that correction.
 */
export async function voidDocument(
  tx: AppDb,
  input: { facilityId: string; documentId: string; reason: string; voidedBy: DocumentActor | null; at?: Date },
): Promise<IssuedDocument> {
  const [voided] = await tx
    .update(documents)
    .set({ voidedAt: input.at ?? new Date(), voidReason: input.reason })
    .where(and(
      eq(documents.facilityId, input.facilityId),
      eq(documents.id, input.documentId),
      isNull(documents.voidedAt),
    ))
    .returning();

  if (!voided) {
    const [existing] = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.facilityId, input.facilityId), eq(documents.id, input.documentId)))
      .limit(1);
    throw new DocumentVoidError(existing ? "already_voided" : "not_found");
  }

  await recordAudit(tx, {
    facilityId: input.facilityId,
    actorId: input.voidedBy?.userId ?? null,
    action: "document.voided",
    entityType: "document",
    entityId: voided.id,
    summary: `${voided.content.title} ${voided.number} voided`,
    detail: { reason: input.reason },
  });

  return voided;
}
