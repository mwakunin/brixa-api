import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { MAX_TRANSFER_BATCHES, SHORTFALL_APPROVERS, TRANSFER_READERS, TRANSFER_STAFF, WARD_STAFF } from "@/lib/transfers";
import { requireMembershipRole } from "@/middlewares/auth";
import { facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";

/**
 * Stock moved between stores. The stores' staff request, send and receive
 * for any store; nurses request for and receive into a ward's store only.
 * Whoever sends a transfer cannot receive it, and a shortfall's loss is
 * accepted by a second person.
 */
const tags = ["Stock transfers"];
const staff = requireMembershipRole(...TRANSFER_STAFF);
const staffOrWard = requireMembershipRole(...TRANSFER_STAFF, ...WARD_STAFF);
const approvers = requireMembershipRole(...SHORTFALL_APPROVERS);
const readers = requireMembershipRole(...TRANSFER_READERS);

const RefusalSchema = z.object({ message: z.string(), code: z.string(), line: z.number().optional() });
const IdParamsSchema = z.object({ id: z.uuid() });
const ReasonSchema = z.string().trim().min(3).max(200).regex(/^\P{C}+$/u, "One line");
const QuantitySchema = z.number().int().min(1).max(100_000_000);
const lower = (id: string) => id.toLowerCase();

const ItemsSchema = z.array(z.strictObject({ stockItemId: z.uuid(), quantity: QuantitySchema })).min(1).max(200).refine(items => new Set(items.map(i => lower(i.stockItemId))).size === items.length, "Each item once");

/** An item's quantity, taken earliest expiry first; or the batches to take it from. */
const SendLineSchema = z.strictObject({
  stockItemId: z.uuid(),
  quantity: QuantitySchema.optional(),
  batches: z.array(z.strictObject({ batchId: z.uuid(), quantity: QuantitySchema })).min(1).max(20).refine(b => new Set(b.map(x => lower(x.batchId))).size === b.length, "Each batch once").optional(),
}).refine(l => (l.quantity === undefined) !== (l.batches === undefined), { message: "Give a quantity or the batches, one of them", path: ["quantity"] });
const SendLinesSchema = z.array(SendLineSchema).min(1).max(200);

const RequestBodySchema = z.strictObject({ fromStoreId: z.uuid(), toStoreId: z.uuid(), items: ItemsSchema });
const SendBodySchema = z.strictObject({ lines: SendLinesSchema });
const DirectBodySchema = z.strictObject({ fromStoreId: z.uuid(), toStoreId: z.uuid(), lines: SendLinesSchema });
const ReceiveBodySchema = z.strictObject({
  /** What arrived of each batch; one not named arrived whole. */
  // As many as a transfer carries (`MAX_TRANSFER_BATCHES`), so each batch's loss can be recorded.
  // Up to what a batch's row holds: two lines of one batch are sent as one.
  received: z.array(z.strictObject({ batchId: z.uuid(), quantity: z.number().int().min(0).max(2_147_483_647) })).max(MAX_TRANSFER_BATCHES).refine(r => new Set(r.map(x => lower(x.batchId))).size === r.length, "Each batch once").optional(),
  /** Needed when less arrived than was sent. */
  shortfallReason: ReasonSchema.optional(),
});
const CloseBodySchema = z.strictObject({ reason: ReasonSchema });

const STATUSES = ["requested", "sent", "received", "cancelled", "declined"] as const;
const ListQuerySchema = z.object({
  storeId: z.uuid().optional(),
  status: z.enum(STATUSES).optional(),
  /** `true`: those received short whose loss a second person has yet to accept. */
  awaitingAcceptance: z.enum(["true"]).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const StoreRefSchema = z.object({ id: z.uuid(), name: z.string() });
const StepSchema = z.object({ byName: z.string(), at: z.string() }).nullable();

const ListedSchema = z.object({
  id: z.uuid(),
  number: z.string(),
  status: z.enum(STATUSES),
  fromStore: StoreRefSchema,
  toStore: StoreRefSchema,
  createdAt: z.string(),
  sentAt: z.string().nullable(),
  receivedAt: z.string().nullable(),
  awaitingAcceptance: z.boolean(),
});

const TransferSchema = ListedSchema.extend({
  requested: StepSchema,
  sent: StepSchema,
  received: StepSchema,
  shortfallReason: z.string().nullable(),
  shortfallAccepted: StepSchema,
  closed: z.object({ byName: z.string(), at: z.string(), reason: z.string() }).nullable(),
  items: z.array(z.object({ stockItemId: z.uuid(), code: z.string(), name: z.string(), baseUnit: z.string(), quantityRequested: z.number() })),
  batches: z.array(z.object({
    batchId: z.uuid(),
    stockItemId: z.uuid(),
    code: z.string(),
    name: z.string(),
    batchNumber: z.string().nullable(),
    expiresOn: z.string().nullable(),
    quantitySent: z.number(),
    quantityReceived: z.number().nullable(),
  })),
});

const forbidden = {
  [HttpStatusCodes.FORBIDDEN]: jsonContent(
    z.union([z.object({ message: z.string(), code: z.literal("ward_store_only") }), z.object({ message: z.string() })]),
    "Role not allowed, or a nurse acting for a store that is not a ward's (`ward_store_only`)",
  ),
};

function stepResponses<B extends z.ZodType>(body: B, status: 200 | 201) {
  return {
    [status]: jsonContent(TransferSchema, "The transfer"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible as the transfer and stores are"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(body), "Invalid"),
    ...tenantResponses,
    ...forbidden,
  };
}

/** A step that starts a transfer. */
function startStep<B extends z.ZodType>(path: string, summary: string, description: string, middleware: typeof staff, body: B) {
  return createRoute({
    tags,
    method: "post",
    path,
    summary,
    description,
    middleware: [middleware] as const,
    request: { headers: facilityHeaders, body: jsonContentRequired(body, "The transfer") },
    responses: stepResponses(body, HttpStatusCodes.CREATED),
  });
}

/** A step on a transfer already started. */
function nextStep<B extends z.ZodType>(path: string, summary: string, description: string, middleware: typeof staff, body: B) {
  return createRoute({
    tags,
    method: "post",
    path,
    summary,
    description,
    middleware: [middleware] as const,
    request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(body, "The step") },
    responses: stepResponses(body, HttpStatusCodes.OK),
  });
}

export const listTransfers = createRoute({
  tags,
  method: "get",
  path: "/stock-transfers",
  summary: "Transfers",
  description: "Newest first, 50 a page (`?offset=`). `?storeId=` for those from or to a store, `?status=`, or `?awaitingAcceptance=true` for the approvers' list.",
  middleware: [readers] as const,
  request: { headers: facilityHeaders, query: ListQuerySchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ transfers: z.array(ListedSchema) }), "Transfers"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(ListQuerySchema), "Invalid filter"),
    ...tenantResponses,
  },
});

export const getTransfer = createRoute({
  tags,
  method: "get",
  path: "/stock-transfers/{id}",
  summary: "One transfer, with what was asked for, sent and received",
  middleware: [readers] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(TransferSchema, "The transfer"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not a transfer id"),
    ...tenantResponses,
  },
});

export const requestTransfer = startStep("/stock-transfers", "Ask another store for stock", "Per item, in base units. Numbered `TRF-`. A nurse asks only for a ward's store.", staffOrWard, RequestBodySchema);
export const sendDirect = startStep("/stock-transfers/send", "Send stock to another store without a request", "Each line by quantity (earliest expiry first, never an expired batch) or by the batches named. The stock leaves the store now.", staff, DirectBodySchema);
export const sendTransfer = nextStep("/stock-transfers/{id}/send", "Send what a request asked for", "Sending approves it. Only items asked for, and never more of one; less may be sent, with no back-order. Each line by quantity, earliest expiry first, or by the batches named.", staff, SendBodySchema);
export const receiveTransfer = nextStep("/stock-transfers/{id}/receive", "Receive a transfer", "Once, by someone other than its sender. A batch not named arrived whole; less than was sent needs `shortfallReason`, and its loss waits for a second person.", staffOrWard, ReceiveBodySchema);
export const acceptShortfall = nextStep("/stock-transfers/{id}/accept-shortfall", "Accept a shortfall's loss", "By the finance manager or a pharmacist other than its receiver (rule 24).", approvers, z.strictObject({}));
export const cancelTransfer = nextStep("/stock-transfers/{id}/cancel", "Cancel a request", "By whoever asked for it, before it is sent.", staffOrWard, CloseBodySchema);
export const declineTransfer = nextStep("/stock-transfers/{id}/decline", "Decline a request", "By the sending store's staff, before it is sent.", staff, CloseBodySchema);

export type ListTransfersRoute = typeof listTransfers;
export type GetTransferRoute = typeof getTransfer;
export type RequestTransferRoute = typeof requestTransfer;
export type SendDirectRoute = typeof sendDirect;
export type SendTransferRoute = typeof sendTransfer;
export type ReceiveTransferRoute = typeof receiveTransfer;
export type AcceptShortfallRoute = typeof acceptShortfall;
export type CancelTransferRoute = typeof cancelTransfer;
export type DeclineTransferRoute = typeof declineTransfer;
