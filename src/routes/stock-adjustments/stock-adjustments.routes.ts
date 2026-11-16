import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { STOCK_READERS } from "@/lib/goods-received";
import { SHORTFALL_APPROVERS, TRANSFER_STAFF } from "@/lib/transfers";
import { requireMembershipRole } from "@/middlewares/auth";
import { facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";

/**
 * Write-offs, stock found and corrections: asked for by the stores' staff,
 * approved by the finance manager or a pharmacist other than the asker
 * (rule 24). A batch moves only on approval.
 */
const tags = ["Stock adjustments"];
const staff = requireMembershipRole(...TRANSFER_STAFF);
const approvers = requireMembershipRole(...SHORTFALL_APPROVERS);
const readers = requireMembershipRole(...STOCK_READERS);

const RefusalSchema = z.object({ message: z.string(), code: z.string(), line: z.number().optional() });
const IdParamsSchema = z.object({ id: z.uuid() });
const KINDS = ["expired", "damaged", "lost", "found", "correction"] as const;
const STATUSES = ["pending", "approved", "rejected", "withdrawn"] as const;

const AdjustmentSchema = z.object({
  id: z.uuid(),
  storeId: z.uuid(),
  kind: z.enum(KINDS),
  reason: z.string(),
  status: z.enum(STATUSES),
  requestedAt: z.string(),
  decidedAt: z.string().nullable(),
  /** Signed, at the batches' cost: below zero a loss. */
  valueCents: z.number(),
  lines: z.array(z.object({ batchId: z.uuid(), batchNumber: z.string().nullable(), expiresOn: z.string().nullable(), code: z.string(), name: z.string(), quantity: z.number(), valueCents: z.number() })),
});

const RequestBodySchema = z.strictObject({
  storeId: z.uuid(),
  /** A write-off (`expired`, `damaged`, `lost`) takes stock off; `found` puts it on an existing batch; `correction` either. */
  kind: z.enum(KINDS),
  reason: z.string().trim().min(3).max(200).regex(/^\P{C}+$/u, "One line"),
  lines: z.array(z.strictObject({
    batchId: z.uuid(),
    /** In base units: below zero off the shelf, above zero onto it. */
    quantity: z.number().int().min(-100_000_000).max(100_000_000).refine(q => q !== 0, "Not zero"),
  })).min(1).max(200).refine(l => new Set(l.map(x => x.batchId.toLowerCase())).size === l.length, "Each batch once"),
});

const ListQuerySchema = z.object({
  status: z.enum(STATUSES).optional(),
  storeId: z.uuid().optional(),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const refusals = { [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible as the store and batches are") };
const forbidden = {
  [HttpStatusCodes.FORBIDDEN]: jsonContent(
    z.union([z.object({ message: z.string(), code: z.literal("controlled_dispenser") }), z.object({ message: z.string() })]),
    "Role not allowed, or a controlled drug from anyone but a pharmacist with a pharmacy licence (`controlled_dispenser`)",
  ),
};

export const requestAdjustment = createRoute({
  tags,
  method: "post",
  path: "/stock-adjustments",
  summary: "Ask for a stock adjustment",
  description: "Naming batches and quantities, with a reason; `expired` only for batches past their date. Nothing moves until it is approved.",
  middleware: [staff] as const,
  request: { headers: facilityHeaders, body: jsonContentRequired(RequestBodySchema, "The adjustment") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(AdjustmentSchema, "Asked for"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(RequestBodySchema), "Invalid adjustment"),
    ...tenantResponses,
    ...forbidden,
  },
});

export const listAdjustments = createRoute({
  tags,
  method: "get",
  path: "/stock-adjustments",
  summary: "Stock adjustments",
  description: "Newest first, 50 a page. `?status=pending` is the approvers' list.",
  middleware: [readers] as const,
  request: { headers: facilityHeaders, query: ListQuerySchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ adjustments: z.array(AdjustmentSchema) }), "Adjustments"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(ListQuerySchema), "Invalid filter"),
    ...tenantResponses,
  },
});

function decision(path: string, summary: string, description: string, middleware: typeof staff) {
  return createRoute({
    tags,
    method: "post",
    path,
    summary,
    description,
    middleware: [middleware] as const,
    request: { headers: facilityHeaders, params: IdParamsSchema },
    responses: {
      [HttpStatusCodes.OK]: jsonContent(AdjustmentSchema, "Decided"),
      ...refusals,
      [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not an adjustment id"),
      ...tenantResponses,
    },
  });
}

export const approveAdjustment = decision("/stock-adjustments/{id}/approve", "Approve a stock adjustment", "By someone other than its asker (rule 24) and, for a stock take's correction, than anyone who counted it (`counted_it`); its batches move now.", approvers);
export const rejectAdjustment = decision("/stock-adjustments/{id}/reject", "Reject a stock adjustment", "By someone other than its asker; nothing moves.", approvers);
export const withdrawAdjustment = decision("/stock-adjustments/{id}/withdraw", "Withdraw a stock adjustment", "By its asker, while pending.", staff);

export type RequestAdjustmentRoute = typeof requestAdjustment;
export type ListAdjustmentsRoute = typeof listAdjustments;
export type ApproveAdjustmentRoute = typeof approveAdjustment;
export type RejectAdjustmentRoute = typeof rejectAdjustment;
export type WithdrawAdjustmentRoute = typeof withdrawAdjustment;
