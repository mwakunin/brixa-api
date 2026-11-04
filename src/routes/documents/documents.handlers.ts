import { eq } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { TenantRouteHandler } from "@/lib/types";

import { documents } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { documentDefinition } from "@/lib/document-pdf";
import { mayRead } from "@/lib/documents";
import { renderPdf } from "@/lib/pdf";

import type { GetDocumentPdfRoute } from "./documents.routes";

/** The document's number, safe as a file name: a prefix may contain `/`. */
function fileNameFor(number: string) {
  return `${number.replace(/[^\w-]/g, "-")}.pdf`;
}

export const getDocumentPdf: TenantRouteHandler<GetDocumentPdfRoute> = async (c) => {
  const { id } = c.req.valid("param");

  // RLS limits this to the facility's own documents: another's is not found.
  const [document] = await c.var.db.select().from(documents).where(eq(documents.id, id)).limit(1);
  if (!document)
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);

  if (!mayRead(c.var.membership.roles, document.kind))
    return c.json({ message: HttpStatusPhrases.FORBIDDEN }, HttpStatusCodes.FORBIDDEN);

  /*
   * Recorded before rendering, on the request transaction: if rendering
   * fails, the 500 rolls the entry back with everything else, so the log
   * holds exactly the openings that were served (rule 9).
   */
  await recordAudit(c.var.db, {
    facilityId: document.facilityId,
    actorId: c.var.user!.id,
    action: "document.viewed",
    entityType: "document",
    entityId: document.id,
    summary: `${document.content.title} ${document.number} opened`,
    detail: { membershipId: c.var.membership.id },
  });

  const pdf = await renderPdf(documentDefinition(document));

  return c.body(new Uint8Array(pdf), HttpStatusCodes.OK, {
    "content-type": "application/pdf",
    "content-disposition": `inline; filename="${fileNameFor(document.number)}"`,
    // Patient data: no shared cache may keep a copy.
    "cache-control": "no-store",
  });
};
