import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { STOCK_READERS } from "@/lib/goods-received";
import { STOCK_KEEPERS } from "@/lib/stock-items";
import { ONE_LINE } from "@/lib/validation";
import { requireMembershipRole } from "@/middlewares/auth";
import { facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";

/**
 * Stores and their reorder levels: set up by the facility admin, pharmacists
 * and storekeepers; read by every member, since they hold no patient data.
 */
const tags = ["Stores"];
const stockKeepers = requireMembershipRole(...STOCK_KEEPERS);
const stockReaders = requireMembershipRole(...STOCK_READERS);

const RefusalSchema = z.object({ message: z.string(), code: z.string() });
const IdParamsSchema = z.object({ id: z.uuid() });

const STORE_KINDS = ["main", "pharmacy", "ward", "other"] as const;
const NameSchema = z.string().trim().min(1).max(80).regex(ONE_LINE, "One line");

const StoreSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: z.enum(STORE_KINDS),
  isActive: z.boolean(),
});

const CreateBodySchema = z.strictObject({
  name: NameSchema,
  /** The main store, the pharmacy (which dispenses), a ward's store, or another department's. */
  kind: z.enum(STORE_KINDS),
});

const UpdateBodySchema = z.strictObject({
  name: NameSchema.optional(),
  /** False retires it. */
  isActive: z.boolean().optional(),
}).refine(b => b.name !== undefined || b.isActive !== undefined, "Nothing to change");

/** In base units; below it, the item is flagged in this store. Zero flags nothing. */
const LevelSchema = z.number().int().min(0).max(100_000_000);

const LevelsBodySchema = z.strictObject({
  levels: z.array(z.strictObject({ stockItemId: z.uuid(), level: LevelSchema })).min(1).max(500),
}).refine(b => new Set(b.levels.map(l => l.stockItemId.toLowerCase())).size === b.levels.length, {
  message: "Each item once",
  path: ["levels"],
});

const LevelsSchema = z.object({
  levels: z.array(z.object({
    stockItemId: z.uuid(),
    code: z.string(),
    name: z.string(),
    baseUnit: z.string(),
    level: z.number(),
  })),
});

const refusals = {
  [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible with the stores as they are"),
};

export const listStores = createRoute({
  tags,
  method: "get",
  path: "/stores",
  summary: "The facility's stores",
  description: "By name, retired ones included.",
  request: { headers: facilityHeaders },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ stores: z.array(StoreSchema) }), "Stores"),
    ...tenantResponses,
  },
});

export const createStore = createRoute({
  tags,
  method: "post",
  path: "/stores",
  summary: "Set up a store",
  middleware: [stockKeepers] as const,
  request: { headers: facilityHeaders, body: jsonContentRequired(CreateBodySchema, "The store") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(StoreSchema, "Set up"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(CreateBodySchema), "Invalid store"),
    ...tenantResponses,
  },
});

export const updateStore = createRoute({
  tags,
  method: "patch",
  path: "/stores/{id}",
  summary: "Rename a store, or retire it",
  description: "Its kind is fixed.",
  middleware: [stockKeepers] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(UpdateBodySchema, "What changes") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(StoreSchema, "Updated"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(UpdateBodySchema), "Invalid change"),
    ...tenantResponses,
  },
});

export const listReorderLevels = createRoute({
  tags,
  method: "get",
  path: "/stores/{id}/reorder-levels",
  summary: "A store's reorder levels",
  description: "By item code, in each item's base unit. An item with none is never flagged here.",
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(LevelsSchema, "Levels"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not a store id"),
    ...tenantResponses,
  },
});

export const setReorderLevels = createRoute({
  tags,
  method: "put",
  path: "/stores/{id}/reorder-levels",
  summary: "Set reorder levels in a store",
  description:
    "Each item given is set to its level, in its base unit; the store's other "
    + "levels stay as they are. Zero flags nothing. Each change is audited with "
    + "its old and new level.",
  middleware: [stockKeepers] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(LevelsBodySchema, "The levels") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(LevelsSchema, "The store's levels, all of them"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(LevelsBodySchema), "Invalid levels"),
    ...tenantResponses,
  },
});

const BatchStockSchema = z.object({
  batchId: z.uuid(),
  batchNumber: z.string().nullable(),
  expiresOn: z.string().nullable(),
  /** Its last day has passed: never dispensed, waiting to be written off. */
  expired: z.boolean(),
  onHand: z.number(),
  valueCents: z.number(),
});

const StockSchema = z.object({
  items: z.array(z.object({
    stockItemId: z.uuid(),
    code: z.string(),
    name: z.string(),
    baseUnit: z.string(),
    packSize: z.number(),
    /** In base units. */
    onHand: z.number(),
    /** At each batch's own cost. */
    valueCents: z.number(),
    reorderLevel: z.number().nullable(),
    /** Earliest expiry first, the order they are used in. */
    batches: z.array(BatchStockSchema),
  })),
});

export const getStoreStock = createRoute({
  tags,
  method: "get",
  path: "/stores/{id}/stock",
  summary: "What a store holds",
  description:
    "Each item it holds or has a reorder level for, by code: on hand in base "
    + "units, its batches earliest expiry first (expired ones marked), and "
    + "its value at each batch's cost. Read by stock keepers, pharmacy "
    + "technicians, the finance manager and the auditor.",
  middleware: [stockReaders] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(StockSchema, "Its stock"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not a store id"),
    ...tenantResponses,
  },
});

export type ListStoresRoute = typeof listStores;
export type GetStoreStockRoute = typeof getStoreStock;
export type CreateStoreRoute = typeof createStore;
export type UpdateStoreRoute = typeof updateStore;
export type ListReorderLevelsRoute = typeof listReorderLevels;
export type SetReorderLevelsRoute = typeof setReorderLevels;
