import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { DOCUMENT_READERS } from "@/lib/documents";
import { requireMembershipRole } from "@/middlewares/auth";
import { facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";
import { BILLERS, FINANCE } from "@/routes/invoices/invoices.routes";

/**
 * Credit notes, waivers and write-offs (SCHEMA.md §7.5). A biller asks; a
 * finance manager or the facility admin approves, never the one who asked
 * (rule 24; approvers decided 2026-11-04).
 */
const tags = ["Adjustments"];

const billersOnly = requireMembershipRole(...BILLERS);
const financeOnly = requireMembershipRole(...FINANCE);
const readersOnly = requireMembershipRole(...DOCUMENT_READERS.invoice);

const RefusalSchema = z.object({ message: z.string(), code: z.string() });
const IdParamsSchema = z.object({ id: z.uuid() });
const KindSchema = z.enum(["credit_note", "waiver", "write_off"]);
const StatusSchema = z.enum(["pending", "approved", "rejected", "withdrawn"]);

const AdjustmentSchema = z.object({
  id: z.uuid(),
  invoiceId: z.uuid(),
  invoiceNumber: z.string().nullable(),
  /** An approved credit note's own document (to print, `/documents/{id}/pdf`) and number. */
  documentId: z.uuid().nullable(),
  number: z.string().nullable(),
  kind: KindSchema,
  amountCents: z.number().int(),
  reason: z.string(),
  status: StatusSchema,
  /** Memberships. */
  requestedBy: z.uuid(),
  requestedAt: z.string(),
  decidedBy: z.uuid().nullable(),
  decidedAt: z.string().nullable(),
  /** Set once a second person approves reversing it; it then counts for nothing. */
  reversedAt: z.string().nullable(),
  reversalReason: z.string().nullable(),
});

const RequestBodySchema = z.object({
  /** `credit_note` corrects a billing error and is numbered; `waiver` forgives; `write_off` gives up on a debt. */
  kind: KindSchema,
  /** Whole shillings, in cents. */
  amountCents: z.number().int().positive().max(2_000_000_000).refine(c => c % 100 === 0, "Whole shillings only"),
  reason: z.string().trim().min(3).max(200).regex(/^\P{C}+$/u, "One line"),
});

const decisionResponses = {
  [HttpStatusCodes.OK]: jsonContent(AdjustmentSchema, "Decided"),
  [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible as asked"),
  [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not an adjustment id"),
  ...tenantResponses,
};

export const requestAdjustment = createRoute({
  tags,
  method: "post",
  path: "/invoices/{id}/adjustments",
  summary: "Ask for an adjustment",
  description: "Against a finalised invoice, within what is left on it. Takes effect when a finance manager or the facility admin approves it.",
  middleware: [billersOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(RequestBodySchema, "The adjustment") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(AdjustmentSchema, "Asked for"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible as asked"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(RequestBodySchema), "Invalid adjustment"),
    ...tenantResponses,
  },
});

export const listAdjustments = createRoute({
  tags,
  method: "get",
  path: "/adjustments",
  summary: "Adjustments, newest first",
  description: "`?status=pending` is the approver's queue. At most 100.",
  middleware: [readersOnly] as const,
  request: { headers: facilityHeaders, query: z.object({ status: StatusSchema.optional() }) },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ adjustments: z.array(AdjustmentSchema) }), "Adjustments"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(z.object({ status: StatusSchema.optional() })), "Unknown status"),
    ...tenantResponses,
  },
});

export const approveAdjustment = createRoute({
  tags,
  method: "post",
  path: "/adjustments/{id}/approve",
  summary: "Approve an adjustment",
  description: "By someone other than the requester. A credit note is numbered and printed now.",
  middleware: [financeOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: decisionResponses,
});

export const rejectAdjustment = createRoute({
  tags,
  method: "post",
  path: "/adjustments/{id}/reject",
  summary: "Reject an adjustment",
  middleware: [financeOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: decisionResponses,
});

export const withdrawAdjustment = createRoute({
  tags,
  method: "post",
  path: "/adjustments/{id}/withdraw",
  summary: "Withdraw an adjustment you asked for",
  middleware: [billersOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: decisionResponses,
});

export type RequestAdjustmentRoute = typeof requestAdjustment;
export type ListAdjustmentsRoute = typeof listAdjustments;
export type ApproveAdjustmentRoute = typeof approveAdjustment;
export type RejectAdjustmentRoute = typeof rejectAdjustment;
export type WithdrawAdjustmentRoute = typeof withdrawAdjustment;

const ReversalSchema = z.object({
  id: z.uuid(),
  adjustmentId: z.uuid(),
  invoiceId: z.uuid(),
  kind: KindSchema,
  amountCents: z.number().int(),
  reason: z.string(),
  status: StatusSchema,
  requestedBy: z.uuid(),
  requestedAt: z.string(),
  decidedBy: z.uuid().nullable(),
  decidedAt: z.string().nullable(),
});

const ReversalBodySchema = z.object({ reason: RequestBodySchema.shape.reason });

const reversalResponses = {
  [HttpStatusCodes.OK]: jsonContent(ReversalSchema, "Decided"),
  [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible as asked"),
  [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not a reversal id"),
  ...tenantResponses,
};

export const requestReversal = createRoute({
  tags,
  method: "post",
  path: "/adjustments/{id}/reversals",
  summary: "Ask to reverse an approved adjustment",
  description: "Takes effect when a finance manager or the facility admin, not the asker, approves it. The amount then owes again; a credit note's document is voided.",
  middleware: [billersOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(ReversalBodySchema, "Why") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(ReversalSchema, "Asked for"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible as asked"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(ReversalBodySchema), "Invalid request"),
    ...tenantResponses,
  },
});

export const listReversals = createRoute({
  tags,
  method: "get",
  path: "/adjustment-reversals",
  summary: "Requests to reverse adjustments, newest first",
  description: "`?status=pending` is the approver's queue. At most 100. Audited.",
  middleware: [readersOnly] as const,
  request: { headers: facilityHeaders, query: z.object({ status: StatusSchema.optional() }) },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ reversals: z.array(ReversalSchema) }), "Requests"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(z.object({ status: StatusSchema.optional() })), "Unknown status"),
    ...tenantResponses,
  },
});

function reversalAction(action: "approve" | "reject" | "withdraw", summary: string, middleware: typeof financeOnly) {
  return createRoute({
    tags,
    method: "post",
    path: `/adjustment-reversals/{id}/${action}`,
    summary,
    middleware: [middleware] as const,
    request: { headers: facilityHeaders, params: IdParamsSchema },
    responses: reversalResponses,
  });
}

export const approveReversal = reversalAction("approve", "Approve reversing an adjustment", financeOnly);
export const rejectReversal = reversalAction("reject", "Reject reversing an adjustment", financeOnly);
export const withdrawReversal = reversalAction("withdraw", "Withdraw your request to reverse an adjustment", billersOnly);

export type RequestReversalRoute = typeof requestReversal;
export type ListReversalsRoute = typeof listReversals;
export type ApproveReversalRoute = typeof approveReversal;
export type RejectReversalRoute = typeof rejectReversal;
export type WithdrawReversalRoute = typeof withdrawReversal;
