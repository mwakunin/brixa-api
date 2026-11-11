import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { requireMembershipRole } from "@/middlewares/auth";
import { facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";

/**
 * The item catalogue and its prices. The facility admin and the finance
 * manager keep both (CLAUDE.md §6); every price change needs the other one,
 * or a second of either, to approve it (rule 24). Everyone may read prices.
 */
const tags = ["Prices"];

export const PRICE_KEEPERS = ["facility_admin", "finance_manager"] as const;
const keepersOnly = requireMembershipRole(...PRICE_KEEPERS);

const RefusalSchema = z.object({ message: z.string(), code: z.string() });
const CATEGORIES = ["consultation", "bed_day", "lab", "imaging", "procedure", "drug", "consumable", "service", "other"] as const;

const ItemSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  category: z.enum(CATEGORIES),
  isActive: z.boolean(),
  /** Today's cash price in cents, or null if the item has none. */
  cashPriceCents: z.number().int().nullable(),
});

const ItemBodySchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9./-]{0,23}$/, "Letters, digits and . / - only, up to 24"),
  name: z.string().trim().min(2).max(120).regex(/^\P{C}+$/u, "One line"),
  category: z.enum(CATEGORIES),
});

const ChangeLineSchema = z.object({
  billableItemId: z.uuid(),
  /** Cents; a fractional shilling is allowed in a unit price (SPEC.md D2). */
  /** Up to KES 10 million: well inside a Postgres integer of cents. */
  unitPriceCents: z.number().int().min(0).max(1_000_000_000),
});

const ChangeBodySchema = z.object({
  effectiveFrom: z.iso.date(),
  reason: z.string().trim().min(3).max(300).regex(/^\P{C}+$/u, "One line"),
  lines: z.array(ChangeLineSchema).min(1).max(2000),
});

const STATUSES = ["pending", "approved", "rejected", "withdrawn"] as const;

const ChangeSchema = z.object({
  id: z.uuid(),
  status: z.enum(STATUSES),
  effectiveFrom: z.string(),
  reason: z.string(),
  requestedAt: z.string(),
  decidedAt: z.string().nullable(),
  lines: z.array(z.object({ billableItemId: z.uuid(), code: z.string(), name: z.string(), unitPriceCents: z.number().int() })),
});

const IdParamsSchema = z.object({ id: z.uuid() });

export const listItems = createRoute({
  tags,
  method: "get",
  path: "/billable-items",
  summary: "The item catalogue, with today's cash prices",
  request: { headers: facilityHeaders },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ items: z.array(ItemSchema) }), "Items"),
    ...tenantResponses,
  },
});

export const createItem = createRoute({
  tags,
  method: "post",
  path: "/billable-items",
  summary: "Add an item to the catalogue",
  description: "An item has no price until a price change for it is approved.",
  middleware: [keepersOnly] as const,
  request: { headers: facilityHeaders, body: jsonContentRequired(ItemBodySchema, "The item") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(ItemSchema, "Added"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Another item has that code"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(ItemBodySchema), "Invalid item"),
    ...tenantResponses,
  },
});

const ListQuerySchema = z.object({ status: z.enum(STATUSES).optional() });

export const listChanges = createRoute({
  tags,
  method: "get",
  path: "/price-changes",
  summary: "Price change requests, newest first",
  description: "At most 100. Pending requests are few in practice; approve or reject them from here.",
  middleware: [keepersOnly] as const,
  request: { headers: facilityHeaders, query: ListQuerySchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ changes: z.array(ChangeSchema) }), "Changes"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(ListQuerySchema), "No such status"),
    ...tenantResponses,
  },
});

export const requestChange = createRoute({
  tags,
  method: "post",
  path: "/price-changes",
  summary: "Request a price change",
  description:
    "Takes effect only once a second person approves it. One request may "
    + "carry the whole tariff, so a facility's first prices are one approval.",
  middleware: [keepersOnly] as const,
  request: { headers: facilityHeaders, body: jsonContentRequired(ChangeBodySchema, "The new prices") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(ChangeSchema, "Requested"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible as asked"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(ChangeBodySchema), "Invalid request"),
    ...tenantResponses,
  },
});

function decision(path: string, summary: string, description: string) {
  return createRoute({
    tags,
    method: "post",
    path,
    summary,
    description,
    middleware: [keepersOnly] as const,
    request: { headers: facilityHeaders, params: IdParamsSchema },
    responses: {
      [HttpStatusCodes.OK]: jsonContent(ChangeSchema, "Decided"),
      [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible as asked"),
      [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not a price change id"),
      ...tenantResponses,
    },
  });
}

export const approveChange = decision(
  "/price-changes/{id}/approve",
  "Approve a price change",
  "By someone other than its requester. Applies the new prices from the effective day.",
);
export const rejectChange = decision("/price-changes/{id}/reject", "Reject a price change", "By someone other than its requester.");
export const withdrawChange = decision("/price-changes/{id}/withdraw", "Withdraw a price change", "By its requester, while pending.");

export type ListItemsRoute = typeof listItems;
export type CreateItemRoute = typeof createItem;
export type ListChangesRoute = typeof listChanges;
export type RequestChangeRoute = typeof requestChange;
export type ApproveChangeRoute = typeof approveChange;
export type RejectChangeRoute = typeof rejectChange;
export type WithdrawChangeRoute = typeof withdrawChange;
