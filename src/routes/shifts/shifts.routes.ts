import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { requireMembershipRole } from "@/middlewares/auth";
import { facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";

/**
 * Cashier shifts (SCHEMA.md §7.4). Cash and card are taken inside the
 * cashier's own open shift; at close they declare the cash counted, and the
 * expected cash and variance are derived.
 */
const tags = ["Cashier shifts"];

/** Who takes money at the counter. */
export const CASHIERS = ["cashier", "finance_manager", "facility_admin"] as const;
/** Who reviews shifts. */
const REVIEWERS = ["finance_manager", "facility_admin", "auditor"] as const;

const cashiersOnly = requireMembershipRole(...CASHIERS);
const reviewersOnly = requireMembershipRole(...REVIEWERS);
const cashiersOrReviewers = requireMembershipRole(...CASHIERS, "auditor");

const RefusalSchema = z.object({ message: z.string(), code: z.string() });
const IdParamsSchema = z.object({ id: z.uuid() });
const WholeShillings = z.number().int().min(0).max(2_000_000_000).refine(c => c % 100 === 0, "Whole shillings only");

export const ShiftSchema = z.object({
  id: z.uuid(),
  /** The cashier's membership. */
  cashierId: z.uuid(),
  openedAt: z.string(),
  openingFloatCents: z.number().int(),
  closedAt: z.string().nullable(),
  declaredCashCents: z.number().int().nullable(),
  cashCents: z.number().int(),
  cardCents: z.number().int(),
  paymentCount: z.number().int(),
  /** The float plus cash taken. */
  expectedCashCents: z.number().int(),
  /** Declared less expected, once closed: negative is a shortage. */
  varianceCents: z.number().int().nullable(),
});

export const openShift = createRoute({
  tags,
  method: "post",
  path: "/cashier-shifts",
  summary: "Open my shift",
  middleware: [cashiersOnly] as const,
  request: { headers: facilityHeaders, body: jsonContentRequired(z.object({ openingFloatCents: WholeShillings }), "The float in the drawer") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(ShiftSchema, "Opened"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "A shift is already open"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(z.object({ openingFloatCents: WholeShillings })), "Invalid float"),
    ...tenantResponses,
  },
});

export const currentShift = createRoute({
  tags,
  method: "get",
  path: "/cashier-shifts/current",
  summary: "My open shift, if any",
  middleware: [cashiersOnly] as const,
  request: { headers: facilityHeaders },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ shift: ShiftSchema.nullable() }), "The open shift, or null"),
    ...tenantResponses,
  },
});

export const listShifts = createRoute({
  tags,
  method: "get",
  path: "/cashier-shifts",
  summary: "Recent shifts, newest first",
  description: "At most 50, for finance to review.",
  middleware: [reviewersOnly] as const,
  request: { headers: facilityHeaders },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ shifts: z.array(ShiftSchema) }), "Shifts"),
    ...tenantResponses,
  },
});

export const getShift = createRoute({
  tags,
  method: "get",
  path: "/cashier-shifts/{id}",
  summary: "A shift and its takings",
  description: "A cashier sees their own; finance and auditors see any.",
  middleware: [cashiersOrReviewers] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(ShiftSchema, "The shift"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not a shift id"),
    ...tenantResponses,
  },
});

const CloseBodySchema = z.object({ declaredCashCents: WholeShillings });

export const closeShift = createRoute({
  tags,
  method: "post",
  path: "/cashier-shifts/{id}/close",
  summary: "Close my shift",
  description: "With the cash counted in the drawer. Answers with what was expected and the variance.",
  middleware: [cashiersOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(CloseBodySchema, "The cash counted") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(ShiftSchema, "Closed"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible as asked"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(CloseBodySchema), "Invalid amount"),
    ...tenantResponses,
  },
});

export type OpenShiftRoute = typeof openShift;
export type CurrentShiftRoute = typeof currentShift;
export type ListShiftsRoute = typeof listShifts;
export type GetShiftRoute = typeof getShift;
export type CloseShiftRoute = typeof closeShift;
