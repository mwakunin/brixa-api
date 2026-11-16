import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { TenantRouteHandler } from "@/lib/types";

import { stockAlerts } from "@/lib/stock-alerts";
import { StoreError, storeShown } from "@/lib/stores";

import type { ListAlertsRoute } from "./stock-alerts.routes";

export const listAlerts: TenantRouteHandler<ListAlertsRoute> = async (c) => {
  const { storeId } = c.req.valid("query");
  try {
    if (storeId)
      await storeShown(c.var.db, storeId);
    return c.json(await stockAlerts(c.var.db, { storeId }), HttpStatusCodes.OK);
  }
  catch (err) {
    // The store asked for is the page: one that is not there answers as nothing.
    if (err instanceof StoreError && err.code === "not_found")
      return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
    throw err;
  }
};
