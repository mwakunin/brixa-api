import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import * as itemImport from "@/lib/item-import";
import { PriceError } from "@/lib/prices";
import * as stock from "@/lib/stock-items";

import type { CreateStockItemRoute, ImportItemsRoute, ListStockItemsRoute, PreviewImportRoute, UpdateStockItemRoute } from "./stock-items.routes";

function actorOf(c: Context<TenantBindings>) {
  return { userId: c.var.user!.id, membershipId: c.var.membership.id };
}

function refusal(c: Context, err: unknown) {
  if (!(err instanceof stock.StockItemError))
    return null;
  if (err.code === "not_found")
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
  return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
}

/** Runs a change, answering with the item as the list shows it. */
async function answer(c: Context<TenantBindings>, act: () => Promise<{ id: string }>, status: 200 | 201 = HttpStatusCodes.OK) {
  try {
    const { id } = await act();
    return c.json(await stock.stockItemShown(c.var.db, id), status);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused;
    throw err;
  }
}

export const listStockItems: TenantRouteHandler<ListStockItemsRoute> = async (c) => {
  const filter = c.req.valid("query");
  return c.json({ items: await stock.listStockItems(c.var.db, filter) }, HttpStatusCodes.OK);
};

function importRefusal(c: Context, err: unknown) {
  if (err instanceof itemImport.ItemImportError)
    return c.json({ message: err.message, code: err.code, ...(err.rows ? { rows: err.rows } : {}) }, HttpStatusCodes.CONFLICT);
  if (err instanceof PriceError && err.code === "effective_in_past")
    return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
  return null;
}

export const previewImport: TenantRouteHandler<PreviewImportRoute> = async (c) => {
  const { csv, effectiveFrom } = c.req.valid("json");
  try {
    return c.json({ rows: await itemImport.planImport(c.var.db, csv, { effectiveFrom }) }, HttpStatusCodes.OK);
  }
  catch (err) {
    const refused = importRefusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};

export const importItems: TenantRouteHandler<ImportItemsRoute> = async (c) => {
  const { csv, effectiveFrom } = c.req.valid("json");
  try {
    return c.json(await itemImport.importItems(c.var.db, c.var.facility.id, csv, actorOf(c), { effectiveFrom }), HttpStatusCodes.CREATED);
  }
  catch (err) {
    const refused = importRefusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};

export const createStockItem: TenantRouteHandler<CreateStockItemRoute> = async (c) => {
  const body = c.req.valid("json");
  return answer(c, () => stock.createStockItem(c.var.db, c.var.facility.id, body, actorOf(c)), HttpStatusCodes.CREATED) as never;
};

export const updateStockItem: TenantRouteHandler<UpdateStockItemRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  return answer(c, () => stock.updateStockItem(c.var.db, c.var.facility.id, id, body, actorOf(c))) as never;
};
