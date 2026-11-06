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
  /** An approved credit note's own number. */
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
