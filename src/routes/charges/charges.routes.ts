import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { QUANTITY_PATTERN } from "@/lib/money";
import { requireMembershipRole } from "@/middlewares/auth";
import { facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";

/**
 * Charges on an encounter. Modules capture their own (bed-days today); a
 * person posts one by hand only for a gap, with a reason (rule 16). Every
 * member may see an encounter's charges, and each look is audited.
 */
const tags = ["Charges"];

/** Who posts and cancels charges by hand. */
export const CHARGE_KEEPERS = ["billing_clerk", "finance_manager", "facility_admin"] as const;
const keepersOnly = requireMembershipRole(...CHARGE_KEEPERS);

const RefusalSchema = z.object({ message: z.string(), code: z.string() });
const IdParamsSchema = z.object({ id: z.uuid() });

const ChargeSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  category: z.string(),
  quantity: z.string(),
  unitPriceCents: z.number().int(),
  amountCents: z.number().int(),
  serviceDate: z.string(),
  /** Captured by the nightly bed-day run or at discharge, not by a person. */
  bedDay: z.boolean(),
  manualReason: z.string().nullable(),
  capturedAt: z.string(),
  cancelledAt: z.string().nullable(),
  cancellationReason: z.string().nullable(),
});

const PostBodySchema = z.object({
  billableItemId: z.uuid(),
  /** Up to 3 decimals: `1`, `1.5`, `0.25`. */
  quantity: z.string().regex(QUANTITY_PATTERN, "A positive number with up to 3 decimals").refine(q => Number(q) > 0, "Must be more than zero"),
  reason: z.string().trim().min(3).max(200).regex(/^\P{C}+$/u, "One line"),
  /** Defaults to today. */
  serviceDate: z.iso.date().optional(),
});

const CancelBodySchema = z.object({ reason: z.string().trim().min(3).max(200).regex(/^\P{C}+$/u, "One line") });

export const postCharge = createRoute({
  tags,
  method: "post",
  path: "/encounters/{id}/charges",
  summary: "Post a charge by hand",
  description: "Priced from the cash list for the service date. Needs a reason, and is audited.",
  middleware: [keepersOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(PostBodySchema, "The charge") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(ChargeSchema, "Posted"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible as asked"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(PostBodySchema), "Invalid charge"),
    ...tenantResponses,
  },
});

export const listCharges = createRoute({
  tags,
  method: "get",
  path: "/encounters/{id}/charges",
  summary: "An encounter's charges",
  description: "Cancelled ones included, marked. `totalCents` counts only those still standing.",
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ charges: z.array(ChargeSchema), totalCents: z.number().int() }), "Charges"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not an encounter id"),
    ...tenantResponses,
  },
});

export const cancelCharge = createRoute({
  tags,
  method: "post",
  path: "/charges/{id}/cancel",
  summary: "Cancel a charge",
  middleware: [keepersOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(CancelBodySchema, "Why") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ id: z.uuid(), cancelledAt: z.string() }), "Cancelled"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Already cancelled"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(CancelBodySchema), "Invalid request"),
    ...tenantResponses,
  },
});

export type PostChargeRoute = typeof postCharge;
export type ListChargesRoute = typeof listCharges;
export type CancelChargeRoute = typeof cancelCharge;
