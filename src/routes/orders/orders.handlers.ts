import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import * as orders from "@/lib/orders";

import type {
  CancelOrderItemRoute,
  ListOrdersRoute,
  MarkServiceDoneRoute,
  PlaceOrderRoute,
  PlaceWalkInOrderRoute,
} from "./orders.routes";

import { orderJson } from "./order-schemas";

function actorOf(c: Context<TenantBindings>): orders.OrderActor {
  return { userId: c.var.user!.id, membershipId: c.var.membership.id, roles: c.var.membership.roles };
}

function refusal(c: Context, err: unknown) {
  if (!(err instanceof orders.OrderError))
    return null;
  if (err.code === "encounter_not_found" || err.code === "not_found")
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
  if (err.code === "not_yours_to_cancel")
    return c.json({ message: err.message, code: err.code }, HttpStatusCodes.FORBIDDEN);
  return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
}

/** Runs a change, answering with the order as the list shows it, without a second audit entry. */
async function answer(c: Context<TenantBindings>, act: () => Promise<orders.ShownOrder>, status: 200 | 201 = HttpStatusCodes.OK) {
  try {
    return c.json(orderJson(await act()), status);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused;
    throw err;
  }
}

async function shownOrder(c: Context<TenantBindings>, order: { id: string; encounterId: string }) {
  const [shown] = await orders.ordersOf(c.var.db, order.encounterId, { orderId: order.id });
  return shown;
}

export const placeOrder: TenantRouteHandler<PlaceOrderRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  return answer(c, async () => shownOrder(c, await orders.placeOrder(c.var.db, c.var.facility.id, id, body, actorOf(c))), HttpStatusCodes.CREATED) as never;
};

export const placeWalkInOrder: TenantRouteHandler<PlaceWalkInOrderRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { requester, labTestIds, urgency, indication } = c.req.valid("json");
  const input = { requester: requester ?? "self" as const, labTestIds, urgency, indication };
  return answer(c, async () => shownOrder(c, await orders.placeWalkInOrder(c.var.db, c.var.facility.id, id, input, actorOf(c))), HttpStatusCodes.CREATED) as never;
};

export const listOrders: TenantRouteHandler<ListOrdersRoute> = async (c) => {
  const { id } = c.req.valid("param");
  try {
    const listed = await orders.listOrders(c.var.db, c.var.facility.id, id, actorOf(c));
    return c.json({ orders: listed.map(orderJson) }, HttpStatusCodes.OK);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};

export const cancelOrderItem: TenantRouteHandler<CancelOrderItemRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { reason } = c.req.valid("json");
  return answer(c, async () => {
    await orders.cancelOrderItem(c.var.db, c.var.facility.id, id, reason, actorOf(c));
    return orders.orderOfItem(c.var.db, id);
  }) as never;
};

export const markServiceDone: TenantRouteHandler<MarkServiceDoneRoute> = async (c) => {
  const { id } = c.req.valid("param");
  return answer(c, async () => {
    await orders.markServiceDone(c.var.db, c.var.facility.id, id, actorOf(c));
    return orders.orderOfItem(c.var.db, id);
  }) as never;
};
