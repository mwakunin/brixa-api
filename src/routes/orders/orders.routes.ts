import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { ORDERING_STAFF, PERFORMING_STAFF, WALK_IN_STAFF } from "@/lib/orders";
import { CLINICAL_ROLES } from "@/lib/professions";
import { requireClinicalRole, requireMembershipRole } from "@/middlewares/auth";
import { clinicalResponses, facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";

import { OrderSchema } from "./order-schemas";

/**
 * Orders: lab tests and services asked for on an encounter, each charged as
 * it is ordered. A clinician orders under a current licence; a walk-in lab
 * client's request is entered by a records clerk or the lab. Reading orders
 * is for clinical staff, and audited.
 */
const tags = ["Orders"];

const orderingStaff = requireClinicalRole(...ORDERING_STAFF);
const walkInStaff = requireMembershipRole(...WALK_IN_STAFF);
const performingStaff = requireClinicalRole(...PERFORMING_STAFF);
const clinicalReaders = requireMembershipRole(...CLINICAL_ROLES);
// Narrowed per item by the service: whoever could have placed it, or the lab for a lab test.
const cancellingStaff = requireMembershipRole(...ORDERING_STAFF, ...WALK_IN_STAFF);

const RefusalSchema = z.object({ message: z.string(), code: z.string() });
const IdParamsSchema = z.object({ id: z.uuid() });
const oneLine = (max: number) => z.string().trim().min(1).max(max).regex(/^\P{C}+$/u, "One line");

const ItemBodySchema = z.union([
  z.strictObject({ labTestId: z.uuid() }),
  /** A procedure, imaging or service item. */
  z.strictObject({ billableItemId: z.uuid() }),
]);

const common = {
  urgency: z.enum(["routine", "urgent"]).optional(),
  /** Why it is asked for, for whoever does it. */
  indication: z.string().trim().min(1).max(500).optional(),
};

// Strict, so a misspelt field (`urgnecy`) is refused rather than an urgent order going in as routine.
const OrderBodySchema = z.strictObject({
  ...common,
  items: z.array(ItemBodySchema).min(1).max(30),
});

const WalkInBodySchema = z.strictObject({
  ...common,
  /** The outside requester, as their form names them. */
  requester: z.strictObject({
    name: oneLine(120),
    facility: oneLine(120),
    licenceNumber: oneLine(40).optional(),
  }).optional(),
  /** The client asks for the tests themselves, with no requester. */
  selfRequested: z.literal(true).optional(),
  labTestIds: z.array(z.uuid()).min(1).max(30),
}).refine(b => (b.requester !== undefined) !== (b.selfRequested === true), {
  message: "Name the outside requester, or mark the request self-requested; not both",
  path: ["requester"],
});

const CancelBodySchema = z.strictObject({ reason: oneLine(200) });

const refusals = {
  [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible in the encounter's, item's or catalogue's state"),
};

export const placeOrder = createRoute({
  tags,
  method: "post",
  path: "/encounters/{id}/orders",
  summary: "Order lab tests and services",
  description:
    "On an open encounter. Each item is charged now, from the cash list; one "
    + "with no price refuses the whole order. Services are procedure, imaging "
    + "or service items.",
  middleware: [orderingStaff] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(OrderBodySchema, "The order") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(OrderSchema, "Ordered"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(OrderBodySchema), "Invalid order"),
    ...clinicalResponses,
  },
});

export const placeWalkInOrder = createRoute({
  tags,
  method: "post",
  path: "/encounters/{id}/walk-in-orders",
  summary: "Enter a walk-in lab client's tests",
  description:
    "On their open outpatient visit: lab tests from an outside requester's "
    + "form, or asked for by the client (`selfRequested`). Each is charged now.",
  middleware: [walkInStaff] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(WalkInBodySchema, "The request") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(OrderSchema, "Entered"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(WalkInBodySchema), "Invalid request"),
    ...tenantResponses,
  },
});

export const listOrders = createRoute({
  tags,
  method: "get",
  path: "/encounters/{id}/orders",
  summary: "An encounter's orders",
  description: "Oldest first, each with its items. Audited.",
  middleware: [clinicalReaders] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ orders: z.array(OrderSchema) }), "Orders"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not an encounter id"),
    ...tenantResponses,
  },
});

export const cancelOrderItem = createRoute({
  tags,
  method: "post",
  path: "/order-items/{id}/cancel",
  summary: "Cancel an item not yet done",
  description:
    "Its charge is cancelled while unbilled; a billed one stands, to be "
    + "credited or refunded. By whoever could have placed the order, or the "
    + "lab for a lab test.",
  middleware: [cancellingStaff] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(CancelBodySchema, "Why") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(OrderSchema, "Cancelled; the order as it now stands"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(CancelBodySchema), "No reason given"),
    ...tenantResponses,
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      z.union([RefusalSchema, z.object({ message: z.string() })]),
      "Role not allowed, or `not_yours_to_cancel`: not someone who could have placed this order",
    ),
  },
});

export const markServiceDone = createRoute({
  tags,
  method: "post",
  path: "/order-items/{id}/done",
  summary: "Mark a service performed",
  description: "By the clinician who performed it. A lab test is done once its specimen is collected instead.",
  middleware: [performingStaff] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(OrderSchema, "Done; the order as it now stands"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not an item id"),
    ...clinicalResponses,
  },
});

export type PlaceOrderRoute = typeof placeOrder;
export type PlaceWalkInOrderRoute = typeof placeWalkInOrder;
export type ListOrdersRoute = typeof listOrders;
export type CancelOrderItemRoute = typeof cancelOrderItem;
export type MarkServiceDoneRoute = typeof markServiceDone;
