import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { MAX_LINE_QUANTITY, RECEIVERS, STOCK_READERS } from "@/lib/goods-received";
import { requireMembershipRole } from "@/middlewares/auth";
import { facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";

/**
 * Deliveries into the stores: received by storekeepers, pharmacists and
 * pharmacy technicians; read by them, the facility admin, the finance
 * manager and the auditor, since a note shows what stock cost.
 */
const tags = ["Goods received"];
const receivers = requireMembershipRole(...RECEIVERS);
const readers = requireMembershipRole(...STOCK_READERS);

const RefusalSchema = z.object({ message: z.string(), code: z.string(), line: z.number().optional() });
const IdParamsSchema = z.object({ id: z.uuid() });
const oneLine = (max: number) => z.string().trim().min(1).max(max).regex(/^\P{C}+$/u, "One line");

const LineBodySchema = z.strictObject({
  stockItemId: z.uuid(),
  /** The supplier's; needed for a drug. */
  batchNumber: oneLine(40).optional(),
  /** The last day it may be used; needed for a drug. */
  expiresOn: z.iso.date().optional(),
  /** Whole packs, at the item's pack size. */
  packs: z.number().int().min(1).max(MAX_LINE_QUANTITY).optional(),
  /** Or loose base units, for a broken pack. */
  units: z.number().int().min(1).max(MAX_LINE_QUANTITY).optional(),
  /** The line's total, as the delivery note shows it; zero for donated stock. */
  totalCostCents: z.number().int().min(0).max(2_000_000_000),
}).refine(l => (l.packs === undefined) !== (l.units === undefined), { message: "Give packs or units, one of them", path: ["packs"] });

const ReceiveBodySchema = z.strictObject({
  storeId: z.uuid(),
  /** The supplier, or the donor for donated stock. */
  supplier: oneLine(120),
  /** Their delivery note or invoice number. */
  supplierReference: oneLine(60).optional(),
  /** The day it arrived; today unless given. */
  receivedOn: z.iso.date().optional(),
  lines: z.array(LineBodySchema).min(1).max(100),
});

const ReverseBodySchema = z.strictObject({ reason: z.string().trim().min(3).max(200).regex(/^\P{C}+$/u, "One line") });

const ListQuerySchema = z.object({
  storeId: z.uuid().optional(),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const ListedNoteSchema = z.object({
  id: z.uuid(),
  number: z.string(),
  storeId: z.uuid(),
  storeName: z.string(),
  supplier: z.string(),
  supplierReference: z.string().nullable(),
  receivedOn: z.string(),
  receivedByName: z.string(),
  createdAt: z.string(),
  lines: z.number(),
  totalCostCents: z.number(),
});

const NoteSchema = ListedNoteSchema.extend({
  items: z.array(z.object({
    batchId: z.uuid(),
    line: z.number(),
    stockItemId: z.uuid(),
    code: z.string(),
    name: z.string(),
    batchNumber: z.string().nullable(),
    expiresOn: z.string().nullable(),
    /** In base units. */
    quantity: z.number(),
    packSize: z.number(),
    totalCostCents: z.number(),
    reversal: z.object({ at: z.string(), reason: z.string() }).nullable(),
  })),
});

const ReceivedSchema = NoteSchema.extend({
  /** Lines taken though they expire within 90 days. */
  warnings: z.array(z.object({ line: z.number(), code: z.literal("expires_soon"), expiresOn: z.string() })),
});

export const receiveGoods = createRoute({
  tags,
  method: "post",
  path: "/goods-received",
  summary: "Receive a delivery into a store",
  description:
    "Numbered `GRN-`. Each line is its own batch at its own cost, on the "
    + "store's shelf at once. A drug's line needs its batch number and expiry; "
    + "an expired batch is refused, and one expiring within 90 days is taken "
    + "with a warning. A refused line refuses the whole note, naming the line.",
  middleware: [receivers] as const,
  request: { headers: facilityHeaders, body: jsonContentRequired(ReceiveBodySchema, "The delivery") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(ReceivedSchema, "Received"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not receivable as given"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(ReceiveBodySchema), "Invalid delivery"),
    ...tenantResponses,
  },
});

export const listNotes = createRoute({
  tags,
  method: "get",
  path: "/goods-received",
  summary: "Goods-received notes",
  description: "Newest first, 50 a page: `?offset=` for older. `?storeId=` for one store's.",
  middleware: [readers] as const,
  request: { headers: facilityHeaders, query: ListQuerySchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ notes: z.array(ListedNoteSchema) }), "Notes"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(ListQuerySchema), "Invalid filter"),
    ...tenantResponses,
  },
});

export const getNote = createRoute({
  tags,
  method: "get",
  path: "/goods-received/{id}",
  summary: "One goods-received note, with its lines",
  middleware: [readers] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(NoteSchema, "The note"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not a note id"),
    ...tenantResponses,
  },
});

export const reverseBatch = createRoute({
  tags,
  method: "post",
  path: "/stock-batches/{id}/reverse",
  summary: "Reverse a mistyped line",
  description:
    "Takes the whole line back off the shelf, with a reason, while none of "
    + "its stock has moved; it is then received again correctly. Answers with "
    + "its note.",
  middleware: [receivers] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(ReverseBodySchema, "Why") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(NoteSchema, "Reversed"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not reversible"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(ReverseBodySchema), "Invalid reason"),
    ...tenantResponses,
  },
});

export type ReceiveGoodsRoute = typeof receiveGoods;
export type ListNotesRoute = typeof listNotes;
export type GetNoteRoute = typeof getNote;
export type ReverseBatchRoute = typeof reverseBatch;
