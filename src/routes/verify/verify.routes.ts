import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { VERIFICATION_CODE_PATTERN } from "@/lib/verification";
import { rateLimits } from "@/middlewares/rate-limit";

const tags = ["Verification"];

export const VerifiedDocumentSchema = z.object({
  verified: z.literal(true),
  kind: z.string(),
  title: z.string(),
  number: z.string(),
  issuedAt: z.string(),
  issuer: z.object({ name: z.string(), kmhfrCode: z.string() }),
  /** `withdrawn`: it was genuine, and has since been voided. */
  status: z.enum(["valid", "withdrawn"]),
});

/** The path: a code shaped like the ones this system mints. */
const CodeParamsSchema = z.object({
  code: z.string().regex(VERIFICATION_CODE_PATTERN).openapi({ description: "The code under the QR" }),
});

export const verifyDocument = createRoute({
  tags,
  method: "get",
  path: "/verify/{code}",
  summary: "Check a printed document is genuine",
  description:
    "Called by the staff app's public verify page, which a document's QR code "
    + "opens. No session and no facility header: the code names the document. "
    + "Answers who issued it, its number and date, and whether it still stands. "
    + "It shows nothing about the patient.",
  middleware: [rateLimits.verify()] as const,
  request: { params: CodeParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(VerifiedDocumentSchema, "Issued by this facility"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      z.object({ verified: z.literal(false), message: z.string() }),
      "No document carries this code",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(CodeParamsSchema),
      "Not a verification code",
    ),
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(
      z.object({ message: z.string(), retryAfterSeconds: z.number().int().positive() }),
      "Too many checks",
    ),
  },
});

export type VerifyDocumentRoute = typeof verifyDocument;
