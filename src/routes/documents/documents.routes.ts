import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";

import { facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";

/**
 * Printed documents, reprinted from what was frozen when each was issued.
 * Issuing and voiding have no endpoint of their own: the module whose work a
 * document records (a payment, for a receipt) does both in its own
 * transaction.
 */
const tags = ["Documents"];

export const getDocumentPdf = createRoute({
  tags,
  method: "get",
  path: "/documents/{id}/pdf",
  summary: "Print a document",
  description:
    "The document exactly as issued, as a PDF, with VOID across it if it has "
    + "been voided. Who may open one depends on its kind (a receipt: cashier, "
    + "billing clerk, finance manager, facility admin, auditor). Every opening "
    + "is recorded in the audit log.",
  request: {
    headers: facilityHeaders,
    params: z.object({ id: z.uuid() }),
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: { "application/pdf": { schema: z.string().openapi({ format: "binary" }) } },
      description: "The PDF",
    },
    ...tenantResponses,
  },
});

export type GetDocumentPdfRoute = typeof getDocumentPdf;
