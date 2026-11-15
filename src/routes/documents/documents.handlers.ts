import { eq } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { TenantRouteHandler } from "@/lib/types";

import { documents } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { documentDefinition } from "@/lib/document-pdf";
import { mayRead } from "@/lib/documents";
import { renderPdf } from "@/lib/pdf";
import { recordRefusal } from "@/lib/refusal-audit";
import { documentSight } from "@/lib/sensitivity";

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

  // A prescription or report of a restricted order (rule 27) opens only for those who may see it.
  const seen = await documentSight(c.var.db, document, { userId: c.var.user!.id, membershipId: c.var.membership.id, roles: c.var.membership.roles });
  if (seen.sight === "restricted") {
    // On record in its own transaction: the 403 rolls back the request's (rule 27).
    await recordRefusal(document.facilityId, {
      actorId: c.var.user!.id,
      action: "document.view_refused",
      entityType: "document",
      entityId: document.id,
      summary: `${document.content.title} ${document.number} refused: restricted`,
      detail: { membershipId: c.var.membership.id },
    });
    return c.json({ message: "This record is restricted; break the glass on the patient to open it", code: "restricted" }, HttpStatusCodes.FORBIDDEN);
  }

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
    detail: { membershipId: c.var.membership.id, ...(seen.grantId ? { breakGlassId: seen.grantId } : {}) },
  });

  const pdf = await renderPdf(documentDefinition(document));

  return c.body(new Uint8Array(pdf), HttpStatusCodes.OK, {
    "content-type": "application/pdf",
    "content-disposition": `inline; filename="${fileNameFor(document.number)}"`,
    // Patient data: no shared cache may keep a copy.
    "cache-control": "no-store",
  });
};
