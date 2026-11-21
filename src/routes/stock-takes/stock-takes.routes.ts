import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { STOCK_READERS } from "@/lib/goods-received";
import { TRANSFER_STAFF, WARD_STAFF } from "@/lib/transfers";
import { ONE_LINE } from "@/lib/validation";
import { requireMembershipRole } from "@/middlewares/auth";
import { facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";

/**
 * Stock takes: counted blind by the stores' staff (nurses for a ward's
 * store), the differences approved by a second person as one correction.
 */
const tags = ["Stock takes"];
const counters = requireMembershipRole(...TRANSFER_STAFF, ...WARD_STAFF);
const readers = requireMembershipRole(...STOCK_READERS, ...WARD_STAFF);

const RefusalSchema = z.object({ message: z.string(), code: z.string() });
const IdParamsSchema = z.object({ id: z.uuid() });
const STATUSES = ["counting", "submitted", "cancelled"] as const;

const ListedSchema = z.object({
  id: z.uuid(),
  number: z.string(),
  storeId: z.uuid(),
  scope: z.enum(["store", "items"]),
  status: z.enum(STATUSES),
  openedAt: z.string(),
  submittedAt: z.string().nullable(),
  /** The correction asked for its differences; null when it matched, or until submitted. */
  adjustmentId: z.uuid().nullable(),
});

const TakeSchema = ListedSchema.extend({
  /** Blind while counting: `expected` and `difference` are null until it is submitted. */
  lines: z.array(z.object({
    batchId: z.uuid(),
    code: z.string(),
    name: z.string(),
    baseUnit: z.string(),
    batchNumber: z.string().nullable(),
    expiresOn: z.string().nullable(),
    counted: z.number().nullable(),
    countedAt: z.string().nullable(),
    expected: z.number().nullable(),
    difference: z.number().nullable(),
  })),
});

const OpenBodySchema = z.strictObject({
  storeId: z.uuid(),
  /** Count only these; the whole store unless given. */
  stockItemIds: z.array(z.uuid()).min(1).max(500).optional(),
});
const CountsBodySchema = z.strictObject({
  counts: z.array(z.strictObject({ batchId: z.uuid(), quantity: z.number().int().min(0).max(2_147_483_647) })).min(1).max(1000).refine(c => new Set(c.map(x => x.batchId.toLowerCase())).size === c.length, "Each batch once"),
});
const CancelBodySchema = z.strictObject({ reason: z.string().trim().min(3).max(200).regex(ONE_LINE, "One line") });
const ListQuerySchema = z.object({
  storeId: z.uuid().optional(),
  status: z.enum(STATUSES).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const refusals = { [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible as the count and store are") };
const forbidden = {
  [HttpStatusCodes.FORBIDDEN]: jsonContent(
    z.union([z.object({ message: z.string(), code: z.enum(["ward_store_only", "controlled_dispenser"]) }), z.object({ message: z.string() })]),
    "Role not allowed; a nurse counting a store that is not a ward's (`ward_store_only`); or a count with a controlled drug submitted by anyone but a pharmacist with a pharmacy licence (`controlled_dispenser`)",
  ),
};

export const openTake = createRoute({
  tags,
  method: "post",
  path: "/stock-takes",
  summary: "Open a count of a store",
  description: "A sheet of every batch the store holds of the items counted. One open count per store; numbered `STK-`.",
  middleware: [counters] as const,
  request: { headers: facilityHeaders, body: jsonContentRequired(OpenBodySchema, "What to count") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(TakeSchema, "Opened"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(OpenBodySchema), "Invalid count"),
    ...tenantResponses,
    ...forbidden,
  },
});

export const listTakes = createRoute({
  tags,
  method: "get",
  path: "/stock-takes",
  summary: "Stock takes",
  description: "Newest first, 50 a page. A nurse is shown the counts of ward stores only.",
  middleware: [readers] as const,
  request: { headers: facilityHeaders, query: ListQuerySchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ takes: z.array(ListedSchema) }), "Stock takes"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(ListQuerySchema), "Invalid filter"),
    ...tenantResponses,
  },
});

export const getTake = createRoute({
  tags,
  method: "get",
  path: "/stock-takes/{id}",
  summary: "A count's sheet",
  description: "Blind while counting: what was expected shows once it is submitted. To a nurse, a count of a store that is not a ward's is not there.",
  middleware: [readers] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(TakeSchema, "The sheet"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not a stock take id"),
    ...tenantResponses,
  },
});

function step<B extends z.ZodType>(path: string, summary: string, description: string, body: B) {
  return createRoute({
    tags,
    method: path.endsWith("/counts") ? "put" : "post",
    path,
    summary,
    description,
    middleware: [counters] as const,
    request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(body, "The step") },
    responses: {
      [HttpStatusCodes.OK]: jsonContent(TakeSchema, "The sheet"),
      ...refusals,
      [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(body), "Invalid"),
      ...tenantResponses,
      ...forbidden,
    },
  });
}

export const recordCounts = step("/stock-takes/{id}/counts", "Record counts", "Each batch counted now, by you; again if it was. A batch found on the shelf and not on the sheet is added.", CountsBodySchema);
export const submitTake = step("/stock-takes/{id}/submit", "Submit a count", "Once every line is counted. Fixes what each line expected at the moment it was counted, and asks for one correction for the differences, for a second person to approve.", z.strictObject({}));
export const cancelTake = step("/stock-takes/{id}/cancel", "Cancel a count", "While it is open; nothing it counted moves.", CancelBodySchema);

export type OpenTakeRoute = typeof openTake;
export type ListTakesRoute = typeof listTakes;
export type GetTakeRoute = typeof getTake;
export type RecordCountsRoute = typeof recordCounts;
export type SubmitTakeRoute = typeof submitTake;
export type CancelTakeRoute = typeof cancelTake;
