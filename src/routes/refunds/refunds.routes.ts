import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { DOCUMENT_READERS } from "@/lib/documents";
import { requireMembershipRole } from "@/middlewares/auth";
import { facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";
import { BILLERS, FINANCE } from "@/routes/invoices/invoices.routes";
import { CASHIERS } from "@/routes/shifts/shifts.routes";

/**
 * Refunds (SCHEMA.md §7.4). A biller asks; the finance manager or the
 * facility admin approves, never the one who asked; a cashier pays it out,
 * numbered and printed then (decided 2026-11-06).
 */
const tags = ["Refunds"];

const billersOnly = requireMembershipRole(...BILLERS);
const financeOnly = requireMembershipRole(...FINANCE);
const cashiersOnly = requireMembershipRole(...CASHIERS);
const readersOnly = requireMembershipRole(...DOCUMENT_READERS.refund);

const RefusalSchema = z.object({ message: z.string(), code: z.string() });
const IdParamsSchema = z.object({ id: z.uuid() });
const StatusSchema = z.enum(["pending", "approved", "rejected", "withdrawn"]);
const MethodSchema = z.enum(["cash", "card", "bank", "mpesa"]);
const ReasonSchema = z.object({ reason: z.string().trim().min(3).max(200).regex(/^\P{C}+$/u, "One line") });

const RefundSchema = z.object({
  id: z.uuid(),
  paymentId: z.uuid(),
  /** The receipt of the payment it returns. */
  receiptNumber: z.string(),
  /** Its own document (to print, `/documents/{id}/pdf`) and number, once paid out. */
  documentId: z.uuid().nullable(),
  number: z.string().nullable(),
  amountCents: z.number().int(),
  reason: z.string(),
  status: StatusSchema,
  /** Memberships. */
  requestedBy: z.uuid(),
  requestedAt: z.string(),
  decidedBy: z.uuid().nullable(),
  decidedAt: z.string().nullable(),
  paidBy: z.uuid().nullable(),
  paidAt: z.string().nullable(),
  method: MethodSchema.nullable(),
  reference: z.string().nullable(),
  reversedAt: z.string().nullable(),
  reversalReason: z.string().nullable(),
});

const RequestBodySchema = z.object({
  /** Whole shillings, in cents. Defaults to all the payment has left. */
  amountCents: z.number().int().positive().max(2_000_000_000).refine(c => c % 100 === 0, "Whole shillings only").optional(),
  reason: ReasonSchema.shape.reason,
});

const PayBodySchema = z.object({
  method: MethodSchema,
  /** The card slip's, bank transfer's or M-Pesa transaction's reference; required for those, refused for cash. */
  reference: z.string().trim().min(3).max(40).regex(/^[\w /-]+$/, "Letters, digits, spaces, / and -").optional(),
}).refine(b => (b.method === "cash") === (b.reference === undefined), {
  message: "Card, bank and M-Pesa refunds need a reference; cash has none",
  path: ["reference"],
});

const actionResponses = {
  [HttpStatusCodes.OK]: jsonContent(RefundSchema, "Done"),
  [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible as asked"),
  [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not a refund id"),
  ...tenantResponses,
};

export const requestRefund = createRoute({
  tags,
  method: "post",
  path: "/payments/{id}/refunds",
  summary: "Ask to refund a payment's unused credit",
  description: "By default all it has left. Takes effect when a finance manager or the facility admin approves it.",
  middleware: [billersOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(RequestBodySchema, "The refund") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(RefundSchema, "Asked for"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible as asked"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(RequestBodySchema), "Invalid refund"),
    ...tenantResponses,
  },
});

const ListQuerySchema = z.object({
  status: StatusSchema.optional(),
  /** `true`: approved, not yet paid out, not reversed. */
  toPay: z.enum(["true"]).optional(),
});

export const listRefunds = createRoute({
  tags,
  method: "get",
  path: "/refunds",
  summary: "Refunds, newest first",
  description: "`?status=pending` is the approver's queue; `?toPay=true` is the cashier's. At most 100. Audited.",
  middleware: [readersOnly] as const,
  request: { headers: facilityHeaders, query: ListQuerySchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ refunds: z.array(RefundSchema) }), "Refunds"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(ListQuerySchema), "Unknown filter"),
    ...tenantResponses,
  },
});

export const approveRefund = createRoute({
  tags,
  method: "post",
  path: "/refunds/{id}/approve",
  summary: "Approve a refund",
  description: "By someone other than the requester. Holds its share of the payment from now on.",
  middleware: [financeOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: actionResponses,
});

export const rejectRefund = createRoute({
  tags,
  method: "post",
  path: "/refunds/{id}/reject",
  summary: "Reject a refund",
  middleware: [financeOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: actionResponses,
});

export const withdrawRefund = createRoute({
  tags,
  method: "post",
  path: "/refunds/{id}/withdraw",
  summary: "Withdraw a refund you asked for",
  middleware: [billersOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: actionResponses,
});

export const payRefund = createRoute({
  tags,
  method: "post",
  path: "/refunds/{id}/pay",
  summary: "Pay out an approved refund",
  description: "Numbered and printed now. Cash and card need my open shift; cash comes out of its drawer.",
  middleware: [cashiersOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(PayBodySchema, "How it was paid") },
  responses: {
    ...actionResponses,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(PayBodySchema), "Invalid payout"),
  },
});

export const reverseRefund = createRoute({
  tags,
  method: "post",
  path: "/refunds/{id}/reverse",
  summary: "Cancel an approved refund, or reverse one paid out in error",
  description: "Its amount returns to the payment's credit; a paid one's document is voided. Not by whoever paid it out.",
  middleware: [financeOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(ReasonSchema, "Why") },
  responses: {
    ...actionResponses,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(ReasonSchema), "Invalid request"),
  },
});

export type RequestRefundRoute = typeof requestRefund;
export type ListRefundsRoute = typeof listRefunds;
export type ApproveRefundRoute = typeof approveRefund;
export type RejectRefundRoute = typeof rejectRefund;
export type WithdrawRefundRoute = typeof withdrawRefund;
export type PayRefundRoute = typeof payRefund;
export type ReverseRefundRoute = typeof reverseRefund;
