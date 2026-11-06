import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

/**
 * Safaricom's callbacks (P2 slice 6). No session and no facility header: the
 * token in the path is the secret that names the facility. Nothing in the
 * body is believed until it is checked against our own records.
 */
const tags = ["M-Pesa callbacks"];

const TokenParamsSchema = z.object({ token: z.string().regex(/^[\w-]{43}$/) });
/** Any JSON: what Safaricom sent is kept and judged by the handler, never refused here. */
const PayloadSchema = z.unknown();
const AnswerSchema = z.object({ ResultCode: z.number().int(), ResultDesc: z.string() });

function callback(path: string, summary: string, description: string) {
  return createRoute({
    tags,
    method: "post",
    path,
    summary,
    description,
    request: { params: TokenParamsSchema, body: jsonContentRequired(PayloadSchema, "As Safaricom sends it") },
    responses: {
      [HttpStatusCodes.OK]: jsonContent(AnswerSchema, "Accepted"),
      [HttpStatusCodes.NOT_FOUND]: jsonContent(AnswerSchema, "No facility has this token"),
      [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(TokenParamsSchema), "Not a callback token"),
    },
  });
}

/** Validation reads nothing from the body, so none is required: refusing here would decline the payment. */
function bodiless(path: string, summary: string, description: string) {
  return createRoute({
    tags,
    method: "post",
    path,
    summary,
    description,
    request: { params: TokenParamsSchema },
    responses: {
      [HttpStatusCodes.OK]: jsonContent(AnswerSchema, "Accepted"),
      [HttpStatusCodes.NOT_FOUND]: jsonContent(AnswerSchema, "No facility has this token"),
      [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(TokenParamsSchema), "Not a callback token"),
    },
  });
}

export const c2bConfirmation = callback(
  "/webhooks/mpesa/{token}/c2b/confirmation",
  "A paybill payment, confirmed",
  "Stored exactly as sent, then matched by its account number to a bill, an admission or a patient; otherwise it waits in the M-Pesa queue.",
);

export const c2bValidation = bodiless(
  "/webhooks/mpesa/{token}/c2b/validation",
  "A paybill payment, before it completes",
  "Always accepted: refusing would fail the payer's payment at the till.",
);

export const stkCallback = callback(
  "/webhooks/mpesa/{token}/stk/callback",
  "The outcome of an M-Pesa prompt",
  "Paid: recorded towards what the prompt was for. Otherwise the prompt is closed as failed.",
);

export type C2bConfirmationRoute = typeof c2bConfirmation;
export type C2bValidationRoute = typeof c2bValidation;
export type StkCallbackRoute = typeof stkCallback;
