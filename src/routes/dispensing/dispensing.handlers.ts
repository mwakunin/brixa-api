import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { DispenseActor } from "@/lib/dispensing";
import type { ShownDispense } from "@/lib/dispensing-views";
import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import * as dispensing from "@/lib/dispensing";
import { dispenseShown, pharmacyWorklist, viewDispense } from "@/lib/dispensing-views";
import { AllocationError } from "@/lib/stock-allocation";

import type { CancelRoute, GetDispenseRoute, HandOverRoute, NotSuppliedRoute, PrepareRoute, WorklistRoute } from "./dispensing.routes";

function actorOf(c: Context<TenantBindings>): DispenseActor {
  const m = c.var.membership;
  return { userId: c.var.user!.id, membershipId: m.id, roles: m.roles, licenceProfession: m.licenceProfession };
}

function refusal(c: Context, err: unknown) {
  if (err instanceof AllocationError)
    return c.json({ message: err.message, code: err.code, line: err.line }, HttpStatusCodes.CONFLICT);
  if (!(err instanceof dispensing.DispenseError))
    return null;
  // A dispense, its prescription, or a medicine named by the path; one named by a line is that line's refusal.
  if (err.code === "not_found" || err.code === "prescription_not_found" || (err.code === "medicine_not_found" && err.line === undefined))
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
  const body = { message: err.message, code: err.code, ...(err.line === undefined ? {} : { line: err.line }) };
  if (err.code === "controlled_dispenser")
    return c.json(body, HttpStatusCodes.FORBIDDEN);
  return c.json(body, HttpStatusCodes.CONFLICT);
}

function dispenseJson(d: ShownDispense) {
  const step = (s: { byName: string; at: Date } | null) => s && { byName: s.byName, at: s.at.toISOString() };
  return {
    ...d,
    prepared: step(d.prepared)!,
    handedOver: step(d.handedOver),
    cancelled: d.cancelled && { ...step(d.cancelled)!, reason: d.cancelled.reason },
  };
}

/** Runs a change, answering with the dispense as it then stands. */
async function answer(c: Context<TenantBindings>, act: () => Promise<{ id: string }>, status: 200 | 201 = HttpStatusCodes.OK) {
  try {
    const { id } = await act();
    return c.json(dispenseJson(await dispenseShown(c.var.db, id)), status);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused;
    throw err;
  }
}

export const worklist: TenantRouteHandler<WorklistRoute> = async (c) => {
  const { waiting, prepared } = await pharmacyWorklist(c.var.db, c.var.facility.id, actorOf(c));
  return c.json({
    waiting: waiting.map(w => ({ ...w, orderedAt: w.orderedAt.toISOString() })),
    prepared: prepared.map(dispenseJson),
  }, HttpStatusCodes.OK);
};

export const getDispense: TenantRouteHandler<GetDispenseRoute> = async (c) => {
  const { id } = c.req.valid("param");
  try {
    return c.json(dispenseJson(await viewDispense(c.var.db, c.var.facility.id, id, actorOf(c))), HttpStatusCodes.OK);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};

export const prepare: TenantRouteHandler<PrepareRoute> = async (c) => {
  const body = c.req.valid("json");
  return answer(c, () => dispensing.prepareDispense(c.var.db, c.var.facility.id, body, actorOf(c)), HttpStatusCodes.CREATED) as never;
};

export const handOver: TenantRouteHandler<HandOverRoute> = async (c) => {
  const { id } = c.req.valid("param");
  return answer(c, () => dispensing.handOver(c.var.db, c.var.facility.id, id, actorOf(c))) as never;
};

export const cancel: TenantRouteHandler<CancelRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { reason } = c.req.valid("json");
  return answer(c, () => dispensing.cancelDispense(c.var.db, c.var.facility.id, id, reason, actorOf(c))) as never;
};

export const notSupplied: TenantRouteHandler<NotSuppliedRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  try {
    await dispensing.markNotSupplied(c.var.db, c.var.facility.id, id, body, actorOf(c));
    return c.body(null, HttpStatusCodes.NO_CONTENT);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};
