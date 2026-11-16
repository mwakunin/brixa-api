import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { ShownStockTake } from "@/lib/stock-takes";
import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import * as takes from "@/lib/stock-takes";

import type { CancelTakeRoute, GetTakeRoute, ListTakesRoute, OpenTakeRoute, RecordCountsRoute, SubmitTakeRoute } from "./stock-takes.routes";

function actorOf(c: Context<TenantBindings>) {
  const m = c.var.membership;
  return { userId: c.var.user!.id, membershipId: m.id, roles: m.roles, licenceProfession: m.licenceProfession };
}

function refusal(c: Context, err: unknown) {
  if (!(err instanceof takes.StockTakeError))
    return null;
  if (err.code === "not_found")
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
  if (err.code === "ward_store_only" || err.code === "controlled_dispenser")
    return c.json({ message: err.message, code: err.code }, HttpStatusCodes.FORBIDDEN);
  return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
}

const iso = (d: Date | null) => d?.toISOString() ?? null;
const listedJson = (t: Omit<ShownStockTake, "lines">) => ({ ...t, openedAt: t.openedAt.toISOString(), submittedAt: iso(t.submittedAt) });
const takeJson = (t: ShownStockTake) => ({ ...listedJson(t), lines: t.lines.map(l => ({ ...l, countedAt: iso(l.countedAt) })) });

async function answer(c: Context<TenantBindings>, act: () => Promise<{ id: string }>, status: 200 | 201 = HttpStatusCodes.OK) {
  try {
    const { id } = await act();
    return c.json(takeJson(await takes.stockTakeShown(c.var.db, id, actorOf(c))), status);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused;
    throw err;
  }
}

export const openTake: TenantRouteHandler<OpenTakeRoute> = async (c) => {
  const body = c.req.valid("json");
  return answer(c, () => takes.openStockTake(c.var.db, c.var.facility.id, body, actorOf(c)), HttpStatusCodes.CREATED) as never;
};

export const listTakes: TenantRouteHandler<ListTakesRoute> = async (c) => {
  const filter = c.req.valid("query");
  return c.json({ takes: (await takes.listStockTakes(c.var.db, filter, actorOf(c))).map(listedJson) }, HttpStatusCodes.OK);
};

export const getTake: TenantRouteHandler<GetTakeRoute> = async (c) => {
  const { id } = c.req.valid("param");
  return answer(c, async () => ({ id })) as never;
};

export const recordCounts: TenantRouteHandler<RecordCountsRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { counts } = c.req.valid("json");
  return answer(c, () => takes.recordCounts(c.var.db, c.var.facility.id, id, counts, actorOf(c))) as never;
};

export const submitTake: TenantRouteHandler<SubmitTakeRoute> = async (c) => {
  const { id } = c.req.valid("param");
  return answer(c, () => takes.submitStockTake(c.var.db, c.var.facility.id, id, actorOf(c))) as never;
};

export const cancelTake: TenantRouteHandler<CancelTakeRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { reason } = c.req.valid("json");
  return answer(c, () => takes.cancelStockTake(c.var.db, c.var.facility.id, id, reason, actorOf(c))) as never;
};
