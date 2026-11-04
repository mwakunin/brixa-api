import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { PatientActor } from "@/lib/patients";
import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import { isExclusionViolation } from "@/lib/db-errors";
import * as prices from "@/lib/prices";

import type {
  ApproveChangeRoute,
  CreateItemRoute,
  ListChangesRoute,
  ListItemsRoute,
  RejectChangeRoute,
  RequestChangeRoute,
  WithdrawChangeRoute,
} from "./prices.routes";

function actorOf(c: Context<TenantBindings>): PatientActor {
  return { userId: c.var.user!.id, membershipId: c.var.membership.id };
}

type Change = Awaited<ReturnType<typeof prices.listPriceChanges>>[number];

function changeJson(change: Change) {
  return {
    id: change.id,
    status: change.status,
    effectiveFrom: change.effectiveFrom,
    reason: change.reason,
    requestedAt: change.requestedAt.toISOString(),
    decidedAt: change.decidedAt?.toISOString() ?? null,
    lines: change.lines.map(({ priceChangeId: _p, ...line }) => line),
  };
}

async function oneChange(c: Context<TenantBindings>, id: string) {
  const [change] = await prices.listPriceChanges(c.var.db, { id });
  return change;
}

function refusal(c: Context<TenantBindings>, err: unknown) {
  if (err instanceof prices.PriceError) {
    if (err.code === "change_not_found" || err.code === "item_not_found")
      return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
    return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
  }
  // Two approvals for the same item at the same moment: the second waits,
  // then finds the first's price in its way. Asking again resolves it.
  if (isExclusionViolation(err))
    return c.json({ message: "Another price change for these items was approved at the same moment; try again", code: "concurrent_change" }, HttpStatusCodes.CONFLICT);
  return null;
}

async function guarded<T>(c: Context<TenantBindings>, act: () => Promise<T>): Promise<T | Response> {
  try {
    return await act();
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused;
    throw err;
  }
}

export const listItems: TenantRouteHandler<ListItemsRoute> = async (c) => {
  return c.json({ items: await prices.listBillableItems(c.var.db) }, HttpStatusCodes.OK);
};

export const createItem: TenantRouteHandler<CreateItemRoute> = async (c) => {
  const body = c.req.valid("json");
  const result = await guarded(c, () => prices.createBillableItem(c.var.db, c.var.facility.id, body, actorOf(c)));
  if (result instanceof Response)
    return result as never;
  const { id, code, name, category, isActive } = result;
  return c.json({ id, code, name, category, isActive, cashPriceCents: null }, HttpStatusCodes.CREATED);
};

export const listChanges: TenantRouteHandler<ListChangesRoute> = async (c) => {
  const { status } = c.req.valid("query");
  const changes = await prices.listPriceChanges(c.var.db, { status });
  return c.json({ changes: changes.map(changeJson) }, HttpStatusCodes.OK);
};

export const requestChange: TenantRouteHandler<RequestChangeRoute> = async (c) => {
  const body = c.req.valid("json");
  const result = await guarded(c, () => prices.requestPriceChange(c.var.db, c.var.facility.id, body, actorOf(c)));
  if (result instanceof Response)
    return result as never;
  return c.json(changeJson(await oneChange(c, result.id)), HttpStatusCodes.CREATED);
};

export const approveChange: TenantRouteHandler<ApproveChangeRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const result = await guarded(c, () => prices.approvePriceChange(c.var.db, c.var.facility.id, id, actorOf(c)));
  if (result instanceof Response)
    return result as never;
  return c.json(changeJson(await oneChange(c, id)), HttpStatusCodes.OK);
};

export const rejectChange: TenantRouteHandler<RejectChangeRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const result = await guarded(c, () => prices.rejectPriceChange(c.var.db, c.var.facility.id, id, actorOf(c)));
  if (result instanceof Response)
    return result as never;
  return c.json(changeJson(await oneChange(c, id)), HttpStatusCodes.OK);
};

export const withdrawChange: TenantRouteHandler<WithdrawChangeRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const result = await guarded(c, () => prices.withdrawPriceChange(c.var.db, c.var.facility.id, id, actorOf(c)));
  if (result instanceof Response)
    return result as never;
  return c.json(changeJson(await oneChange(c, id)), HttpStatusCodes.OK);
};
