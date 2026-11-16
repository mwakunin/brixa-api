import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { ListedReturn } from "@/lib/dispense-returns";
import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import * as returns from "@/lib/dispense-returns";

import type { ApproveReturnRoute, ListReturnsRoute, RecordReturnRoute, RejectReturnRoute } from "./dispense-returns.routes";

function actorOf(c: Context<TenantBindings>) {
  const m = c.var.membership;
  return { userId: c.var.user!.id, membershipId: m.id, roles: m.roles, licenceProfession: m.licenceProfession };
}

function refusal(c: Context, err: unknown) {
  if (!(err instanceof returns.ReturnError))
    return null;
  if (err.code === "line_not_found" || err.code === "not_found")
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
  if (err.code === "controlled_dispenser")
    return c.json({ message: err.message, code: err.code }, HttpStatusCodes.FORBIDDEN);
  return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
}

const json = ({ printedName: _, ...r }: ListedReturn) => ({ ...r, receivedAt: r.receivedAt.toISOString() });

async function answer(c: Context<TenantBindings>, act: () => Promise<{ id: string }>, status: 200 | 201 = HttpStatusCodes.OK) {
  try {
    const { id } = await act();
    return c.json(json(await returns.returnShown(c.var.db, id)), status);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused;
    throw err;
  }
}

export const recordReturn: TenantRouteHandler<RecordReturnRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  return answer(c, () => returns.recordReturn(c.var.db, c.var.facility.id, id, body, actorOf(c)), HttpStatusCodes.CREATED) as never;
};

export const listReturns: TenantRouteHandler<ListReturnsRoute> = async (c) => {
  const filter = c.req.valid("query");
  return c.json({ returns: (await returns.viewReturns(c.var.db, c.var.facility.id, filter, actorOf(c))).map(json) }, HttpStatusCodes.OK);
};

export const approveReturn: TenantRouteHandler<ApproveReturnRoute> = async (c) => {
  const { id } = c.req.valid("param");
  return answer(c, () => returns.approveReturn(c.var.db, c.var.facility.id, id, actorOf(c))) as never;
};

export const rejectReturn: TenantRouteHandler<RejectReturnRoute> = async (c) => {
  const { id } = c.req.valid("param");
  return answer(c, () => returns.rejectReturn(c.var.db, c.var.facility.id, id, actorOf(c))) as never;
};
