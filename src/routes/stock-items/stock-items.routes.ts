import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { STOCK_KEEPERS } from "@/lib/stock-items";
import { requireMembershipRole } from "@/middlewares/auth";
import { facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";

/**
 * What the facility stocks: set up by the facility admin, pharmacists and
 * storekeepers on a `drug` or `consumable` billable item; read by every
 * member, since it holds no patient data.
 */
const tags = ["Stock items"];
const stockKeepers = requireMembershipRole(...STOCK_KEEPERS);

const RefusalSchema = z.object({ message: z.string(), code: z.string() });
const IdParamsSchema = z.object({ id: z.uuid() });

const DrugCodeSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9._/-]{0,31}$/, "A catalogue drug code");
/** A pack of 1,000,000 base units is beyond any real pack, and keeps a received quantity in range. */
const PackSizeSchema = z.number().int().min(1).max(1_000_000);

const DrugSchema = z.object({
  code: z.string(),
  genericName: z.string(),
  strength: z.string(),
  form: z.string(),
  /** What a prescription's quantity is counted in. */
  doseUnit: z.string(),
  controlledSchedule: z.enum(["I", "II", "III", "IV"]).nullable(),
});

const StockItemSchema = z.object({
  id: z.uuid(),
  billableItemId: z.uuid(),
  /** The billable item's code and name. */
  code: z.string(),
  name: z.string(),
  category: z.enum(["drug", "consumable"]),
  drug: DrugSchema.nullable(),
  baseUnit: z.string(),
  packSize: z.number(),
  isActive: z.boolean(),
});

const CreateBodySchema = z.strictObject({
  /** An active `drug` or `consumable` item: the stock item goes by its code and name, and is sold at its price per base unit. */
  billableItemId: z.uuid(),
  /** The catalogue drug a `drug` item is; none for a consumable. */
  drugCode: DrugCodeSchema.optional(),
  /** What one is counted in, e.g. `tablet`, `mL`, `vial`, `piece`. Fixed once set. */
  baseUnit: z.string().trim().min(1).max(20).regex(/^\P{C}+$/u, "One line"),
  /** How many base units a pack holds, e.g. 100 tablets. */
  packSize: PackSizeSchema,
});

const UpdateBodySchema = z.strictObject({
  packSize: PackSizeSchema.optional(),
  /** False retires it. */
  isActive: z.boolean().optional(),
}).refine(b => b.packSize !== undefined || b.isActive !== undefined, "Nothing to change");

const ListQuerySchema = z.object({
  /** Only the items that are this catalogue drug. */
  drugCode: DrugCodeSchema.optional(),
});

export const listStockItems = createRoute({
  tags,
  method: "get",
  path: "/stock-items",
  summary: "The facility's stock items",
  description: "By code, retired ones included.",
  request: { headers: facilityHeaders, query: ListQuerySchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ items: z.array(StockItemSchema) }), "Stock items"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(ListQuerySchema), "Invalid filter"),
    ...tenantResponses,
  },
});

export const createStockItem = createRoute({
  tags,
  method: "post",
  path: "/stock-items",
  summary: "Set up a stock item",
  description:
    "On an active `drug` item, naming its catalogue drug, or an active "
    + "`consumable` item, naming none. Counted in its base unit and received in "
    + "packs; the base unit and the drug are fixed once set.",
  middleware: [stockKeepers] as const,
  request: { headers: facilityHeaders, body: jsonContentRequired(CreateBodySchema, "The stock item") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(StockItemSchema, "Set up"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible with the catalogue as it is"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(CreateBodySchema), "Invalid stock item"),
    ...tenantResponses,
  },
});

export const updateStockItem = createRoute({
  tags,
  method: "patch",
  path: "/stock-items/{id}",
  summary: "Change a stock item's pack size, or retire it",
  description: "An item still in stock in any store cannot be retired.",
  middleware: [stockKeepers] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(UpdateBodySchema, "What changes") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(StockItemSchema, "Updated"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Still in stock"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(UpdateBodySchema), "Invalid change"),
    ...tenantResponses,
  },
});

export type ListStockItemsRoute = typeof listStockItems;
export type CreateStockItemRoute = typeof createStockItem;
export type UpdateStockItemRoute = typeof updateStockItem;
