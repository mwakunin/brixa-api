import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import { storeStock } from "@/lib/stock-levels";
import * as stores from "@/lib/stores";

import type {
  CreateStoreRoute,
  GetStoreStockRoute,
  ListReorderLevelsRoute,
  ListStoresRoute,
  SetReorderLevelsRoute,
  UpdateStoreRoute,
} from "./stores.routes";

function actorOf(c: Context<TenantBindings>) {
  return { userId: c.var.user!.id, membershipId: c.var.membership.id };
}

function refusal(c: Context, err: unknown) {
  if (!(err instanceof stores.StoreError))
    return null;
  if (err.code === "not_found")
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
  return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
}

async function answer<T>(c: Context<TenantBindings>, act: () => Promise<T>, status: 200 | 201 = HttpStatusCodes.OK) {
  try {
    return c.json(await act(), status);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused;
    throw err;
  }
}

function shown(store: { id: string; name: string; kind: stores.StoreKind; isActive: boolean }) {
  return { id: store.id, name: store.name, kind: store.kind, isActive: store.isActive };
}

export const listStores: TenantRouteHandler<ListStoresRoute> = async (c) => {
  return c.json({ stores: await stores.listStores(c.var.db) }, HttpStatusCodes.OK);
};

export const createStore: TenantRouteHandler<CreateStoreRoute> = async (c) => {
  const body = c.req.valid("json");
  return answer(c, async () => shown(await stores.createStore(c.var.db, c.var.facility.id, body, actorOf(c))), HttpStatusCodes.CREATED) as never;
};

export const updateStore: TenantRouteHandler<UpdateStoreRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  return answer(c, async () => shown(await stores.updateStore(c.var.db, c.var.facility.id, id, body, actorOf(c)))) as never;
};

export const getStoreStock: TenantRouteHandler<GetStoreStockRoute> = async (c) => {
  const { id } = c.req.valid("param");
  return answer(c, async () => {
    await stores.storeShown(c.var.db, id);
    return { items: await storeStock(c.var.db, id) };
  }) as never;
};

export const listReorderLevels: TenantRouteHandler<ListReorderLevelsRoute> = async (c) => {
  const { id } = c.req.valid("param");
  return answer(c, async () => ({ levels: await stores.reorderLevelsOf(c.var.db, id) })) as never;
};

export const setReorderLevels: TenantRouteHandler<SetReorderLevelsRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { levels } = c.req.valid("json");
  return answer(c, async () => ({ levels: await stores.setReorderLevels(c.var.db, c.var.facility.id, id, levels, actorOf(c)) })) as never;
};
