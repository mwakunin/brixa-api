import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { MAX_IMPORT_ROWS } from "@/lib/item-import";
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
// It creates billable items as well as stock items, which only the facility admin holds both of.
const adminOnly = requireMembershipRole("facility_admin");

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

/** About 400 characters a row at the most rows a file holds. */
const CsvSchema = z.string().min(1).max(2_000_000);

const PreviewBodySchema = z.strictObject({
  /** `code,name,category,drug_code,base_unit,pack_size,unit_price`, then one row per item. */
  csv: CsvSchema,
});

const ImportBodySchema = z.strictObject({
  csv: CsvSchema,
  /** When the file's prices start, once approved: today unless given. */
  effectiveFrom: z.iso.date().optional(),
});

const PlannedRowSchema = z.object({
  row: z.number(),
  code: z.string(),
  name: z.string(),
  /** A new item and stock item, a stock item on an item already there, or nothing; null while it has problems. */
  action: z.enum(["create", "add_stock_item", "unchanged"]).nullable(),
  /** The cash price per base unit it would request, when that differs from today's. */
  requestedPriceCents: z.number().nullable(),
  problems: z.array(z.string()),
  /** For a drug row naming no catalogue drug. */
  suggestions: z.array(z.object({ code: z.string(), genericName: z.string(), strength: z.string(), form: z.string() })),
});

const ImportRefusalSchema = z.object({
  message: z.string(),
  code: z.enum(["unreadable", "has_problems", "changed_meanwhile", "effective_in_past"]),
  /** The rows with problems, for `has_problems`. */
  rows: z.array(PlannedRowSchema).optional(),
});

export const previewImport = createRoute({
  tags,
  method: "post",
  path: "/stock-items/import/preview",
  summary: "Check an item list before importing it",
  description:
    `What importing would do with each row, and every problem in the file, writing nothing. At most ${MAX_IMPORT_ROWS.toLocaleString("en")} rows. `
    + "A drug row with no `drug_code` is a problem, and lists up to three catalogue drugs its name suggests.",
  middleware: [adminOnly] as const,
  request: { headers: facilityHeaders, body: jsonContentRequired(PreviewBodySchema, "The file") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ rows: z.array(PlannedRowSchema) }), "Row by row"),
    [HttpStatusCodes.CONFLICT]: jsonContent(ImportRefusalSchema, "Not a file this reads"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(PreviewBodySchema), "No file"),
    ...tenantResponses,
  },
});

export const importItems = createRoute({
  tags,
  method: "post",
  path: "/stock-items/import",
  summary: "Import an item list",
  description:
    "Whole or not at all: one row with a problem refuses the file, listing every such row. Each row "
    + "becomes a billable item and its stock item; a code already set up is matched, never duplicated. "
    + "The prices go into one price change for the finance manager to approve. Running a file again changes nothing.",
  middleware: [adminOnly] as const,
  request: { headers: facilityHeaders, body: jsonContentRequired(ImportBodySchema, "The file") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(z.object({
      created: z.number(),
      stockItemsAdded: z.number(),
      unchanged: z.number(),
      /** Awaiting approval; null when no price changed. */
      priceChangeId: z.uuid().nullable(),
    }), "Imported"),
    [HttpStatusCodes.CONFLICT]: jsonContent(ImportRefusalSchema, "Not imported"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(ImportBodySchema), "No file"),
    ...tenantResponses,
  },
});

export type ListStockItemsRoute = typeof listStockItems;
export type PreviewImportRoute = typeof previewImport;
export type ImportItemsRoute = typeof importItems;
export type CreateStockItemRoute = typeof createStockItem;
export type UpdateStockItemRoute = typeof updateStockItem;
