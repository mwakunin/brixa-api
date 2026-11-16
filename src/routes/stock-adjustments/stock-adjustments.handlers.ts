import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { ShownStockAdjustment } from "@/lib/stock-adjustments";
import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import * as adjustments from "@/lib/stock-adjustments";

import type { ApproveAdjustmentRoute, ListAdjustmentsRoute, RejectAdjustmentRoute, RequestAdjustmentRoute, WithdrawAdjustmentRoute } from "./stock-adjustments.routes";

function actorOf(c: Context<TenantBindings>) {
  const m = c.var.membership;
  return { userId: c.var.user!.id, membershipId: m.id, roles: m.roles, licenceProfession: m.licenceProfession };
}

function refusal(c: Context, err: unknown) {
  if (!(err instanceof adjustments.StockAdjustmentError))
    return null;
  if (err.code === "not_found")
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
  const body = { message: err.message, code: err.code, ...(err.line === undefined ? {} : { line: err.line }) };
  if (err.code === "controlled_dispenser" || err.code === "counted_it")
    return c.json(body, HttpStatusCodes.FORBIDDEN);
  return c.json(body, HttpStatusCodes.CONFLICT);
}

const json = (a: ShownStockAdjustment) => ({ ...a, requestedAt: a.requestedAt.toISOString(), decidedAt: a.decidedAt?.toISOString() ?? null });

async function answer(c: Context<TenantBindings>, act: () => Promise<{ id: string }>, status: 200 | 201 = HttpStatusCodes.OK) {
  try {
    const { id } = await act();
    return c.json(json(await adjustments.stockAdjustmentShown(c.var.db, id)), status);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused;
    throw err;
  }
}

export const requestAdjustment: TenantRouteHandler<RequestAdjustmentRoute> = async (c) => {
  const body = c.req.valid("json");
  return answer(c, () => adjustments.requestStockAdjustment(c.var.db, c.var.facility.id, body, actorOf(c)), HttpStatusCodes.CREATED) as never;
};

export const listAdjustments: TenantRouteHandler<ListAdjustmentsRoute> = async (c) => {
  const filter = c.req.valid("query");
  return c.json({ adjustments: (await adjustments.listStockAdjustments(c.var.db, filter)).map(json) }, HttpStatusCodes.OK);
};

export const approveAdjustment: TenantRouteHandler<ApproveAdjustmentRoute> = async (c) => {
  const { id } = c.req.valid("param");
  return answer(c, () => adjustments.approveStockAdjustment(c.var.db, c.var.facility.id, id, actorOf(c))) as never;
};

export const rejectAdjustment: TenantRouteHandler<RejectAdjustmentRoute> = async (c) => {
  const { id } = c.req.valid("param");
  return answer(c, () => adjustments.closeStockAdjustment(c.var.db, c.var.facility.id, id, "rejected", actorOf(c))) as never;
};

export const withdrawAdjustment: TenantRouteHandler<WithdrawAdjustmentRoute> = async (c) => {
  const { id } = c.req.valid("param");
  return answer(c, () => adjustments.closeStockAdjustment(c.var.db, c.var.facility.id, id, "withdrawn", actorOf(c))) as never;
};
