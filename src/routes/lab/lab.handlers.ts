import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { OrderActor } from "@/lib/orders";
import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import * as lab from "@/lib/specimens";

import type {
  CollectSpecimenRoute,
  ReceiveSpecimenRoute,
  RecollectSpecimenRoute,
  RejectSpecimenRoute,
  ViewWorklistRoute,
} from "./lab.routes";

function actorOf(c: Context<TenantBindings>): OrderActor {
  return { userId: c.var.user!.id, membershipId: c.var.membership.id, roles: c.var.membership.roles };
}

function refusal(c: Context, err: unknown) {
  if (!(err instanceof lab.SpecimenError))
    return null;
  if (err.code === "order_not_found" || err.code === "not_found")
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
  return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
}

function iso(d: Date | null) {
  return d ? d.toISOString() : null;
}

function specimenJson(s: lab.ShownSpecimen) {
  return { ...s, collectedAt: s.collectedAt.toISOString(), receivedAt: iso(s.receivedAt), rejectedAt: iso(s.rejectedAt) };
}

/** Runs a change, answering with the specimen as the worklist shows it, without a second audit entry. */
async function answer(c: Context<TenantBindings>, act: () => Promise<{ id: string }>, status: 200 | 201 = HttpStatusCodes.OK) {
  try {
    const changed = await act();
    return c.json(specimenJson(await lab.specimenShown(c.var.db, changed.id)), status);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused;
    throw err;
  }
}

export const viewWorklist: TenantRouteHandler<ViewWorklistRoute> = async (c) => {
  const list = await lab.viewWorklist(c.var.db, c.var.facility.id, actorOf(c));
  return c.json({
    toCollect: list.toCollect.map(d => ({ ...d, orderedAt: d.orderedAt.toISOString() })),
    toReceive: list.toReceive.map(specimenJson),
    inLab: list.inLab.map(specimenJson),
  }, HttpStatusCodes.OK);
};

export const collectSpecimen: TenantRouteHandler<CollectSpecimenRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  return answer(c, () => lab.collectSpecimen(c.var.db, c.var.facility.id, id, body, actorOf(c)), HttpStatusCodes.CREATED) as never;
};

export const receiveSpecimen: TenantRouteHandler<ReceiveSpecimenRoute> = async (c) => {
  const { id } = c.req.valid("param");
  return answer(c, () => lab.receiveSpecimen(c.var.db, c.var.facility.id, id, actorOf(c))) as never;
};

export const rejectSpecimen: TenantRouteHandler<RejectSpecimenRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  return answer(c, () => lab.rejectSpecimen(c.var.db, c.var.facility.id, id, body, actorOf(c))) as never;
};

export const recollectSpecimen: TenantRouteHandler<RecollectSpecimenRoute> = async (c) => {
  const { id } = c.req.valid("param");
  return answer(c, () => lab.recollectSpecimen(c.var.db, c.var.facility.id, id, actorOf(c)), HttpStatusCodes.CREATED) as never;
};
