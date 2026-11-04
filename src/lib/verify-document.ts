import { eq } from "drizzle-orm";

import db from "@/db";
import { documents } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";

import type { DocumentKind } from "./documents";

import { recordAudit } from "./audit";

/**
 * What the public verify page may say about a document: that this facility
 * issued this number on this date, and whether it still stands. Nothing about
 * the patient, and not why it was voided: a prescription's items alone can
 * reveal a condition, and the code may be read off a photo of the paper by
 * someone it was never meant for.
 */
export interface VerifiedDocument {
  kind: DocumentKind;
  title: string;
  number: string;
  issuedAt: Date;
  issuer: { name: string; kmhfrCode: string };
  status: "valid" | "withdrawn";
  withdrawnAt: Date | null;
}

/**
 * Checks a code from a printed document. Null if no document carries it.
 *
 * The lookup is on the OWNER connection: whoever is checking holds a piece of
 * paper and nothing else, no session and no facility. The query can only be
 * by code, so it yields the one document the caller already has, and the
 * rest runs as that document's facility. The check itself is audited there
 * (rule 9), with no actor: the facility can see when its documents were
 * checked.
 */
export async function verifyDocument(code: string): Promise<VerifiedDocument | null> {
  const [found] = await db
    .select({ id: documents.id, facilityId: documents.facilityId })
    .from(documents)
    .where(eq(documents.verificationCode, code))
    .limit(1);
  if (!found)
    return null;

  return runAsFacility(found.facilityId, async (tx) => {
    const [document] = await tx.select().from(documents).where(eq(documents.id, found.id)).limit(1);

    await recordAudit(tx, {
      facilityId: document.facilityId,
      actorId: null,
      action: "document.verified",
      entityType: "document",
      entityId: document.id,
      summary: `${document.content.title} ${document.number} checked by its verification code`,
    });

    return {
      kind: document.kind,
      title: document.content.title,
      number: document.number,
      issuedAt: document.issuedAt,
      issuer: { name: document.content.issuer.name, kmhfrCode: document.content.issuer.kmhfrCode },
      status: document.voidedAt ? "withdrawn" : "valid",
      withdrawnAt: document.voidedAt,
    };
  });
}
