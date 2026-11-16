import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { STOCK_READERS } from "@/lib/goods-received";
import { requireMembershipRole } from "@/middlewares/auth";
import { facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";

/** The pharmacy's and stores' alerts: worked out from the ledger when read. */
const tags = ["Stock alerts"];
const readers = requireMembershipRole(...STOCK_READERS);

const Named = {
  storeId: z.uuid(),
  storeName: z.string(),
  stockItemId: z.uuid(),
  code: z.string(),
  name: z.string(),
  baseUnit: z.string(),
};

const BatchSchema = z.object({
  ...Named,
  batchId: z.uuid(),
  batchNumber: z.string().nullable(),
  expiresOn: z.string(),
  /** Below nought once its last good day has passed. */
  daysLeft: z.number(),
  /** In base units. */
  onHand: z.number(),
});

const AlertsSchema = z.object({
  expired: z.array(BatchSchema),
  expiring: z.array(BatchSchema),
  belowReorder: z.array(z.object({
    ...Named,
    onHand: z.number(),
    reorderLevel: z.number(),
    /** Sent to the store, not received yet: not counted in `onHand`. */
    inTransit: z.number(),
  })),
});

const QuerySchema = z.object({ storeId: z.uuid().optional() });

export const listAlerts = createRoute({
  tags,
  method: "get",
  path: "/stock-alerts",
  summary: "Expiry and low-stock alerts",
  description:
    "Batches past their expiry and still held (to write off), batches within 90 days of it, earliest "
    + "first, and items strictly below their store's reorder level, with what is on its way there. "
    + "Worked out when read: an alert clears when its cause does, and none is dismissed. "
    + "For every store, or `?storeId=` for one. Read by those who read stock.",
  middleware: [readers] as const,
  request: { headers: facilityHeaders, query: QuerySchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(AlertsSchema, "The alerts"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(QuerySchema), "Not a store id"),
    ...tenantResponses,
  },
});

export type ListAlertsRoute = typeof listAlerts;
