import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import * as obs from "@/lib/observations";

import type { ListObservationsRoute, MarkEnteredInErrorRoute, RecordVitalsRoute } from "./observations.routes";

function actorOf(c: Context<TenantBindings>) {
  return { userId: c.var.user!.id, membershipId: c.var.membership.id };
}

/** The body field each refusal is about, when it is about the body. */
const BODY_FIELD: Partial<Record<obs.ObservationErrorCode, string[]>> = {
  implausible: ["readings"],
  blood_pressure_pair: ["readings"],
  observed_out_of_range: ["observedAt"],
};

function refusal(c: Context, err: unknown) {
  if (!(err instanceof obs.ObservationError))
    return null;
  if (err.code === "encounter_not_found" || err.code === "not_found")
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
  const path = BODY_FIELD[err.code];
  if (path) {
    return c.json({
      success: false as const,
      error: { name: "ValidationError", issues: [{ code: "custom" as const, path, message: err.message }] },
    }, HttpStatusCodes.UNPROCESSABLE_ENTITY);
  }
  return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
}

function readingJson(r: Awaited<ReturnType<typeof obs.listObservations>>[number]) {
  return {
    ...r,
    observedAt: r.observedAt.toISOString(),
    enteredInError: r.enteredInError && { at: r.enteredInError.at.toISOString(), reason: r.enteredInError.reason },
  };
}

export const recordVitals: TenantRouteHandler<RecordVitalsRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { readings, observedAt } = c.req.valid("json");
  try {
    const rows = await obs.recordVitals(c.var.db, c.var.facility.id, id, {
      readings,
      observedAt: observedAt ? new Date(observedAt) : undefined,
    }, actorOf(c));
    const ids = new Set(rows.map(r => r.id));
    // Answered as read back, with the recorder's name, without a second audit entry.
    const recorded = (await obs.observationsOf(c.var.db, id)).filter(r => ids.has(r.id));
    return c.json({ observations: recorded.map(readingJson) }, HttpStatusCodes.CREATED);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};

export const listObservations: TenantRouteHandler<ListObservationsRoute> = async (c) => {
  const { id } = c.req.valid("param");
  try {
    const rows = await obs.listObservations(c.var.db, c.var.facility.id, id, actorOf(c));
    return c.json({ observations: rows.map(readingJson) }, HttpStatusCodes.OK);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};

export const markEnteredInError: TenantRouteHandler<MarkEnteredInErrorRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { reason } = c.req.valid("json");
  try {
    const marked = await obs.markEnteredInError(c.var.db, c.var.facility.id, id, reason, actorOf(c));
    return c.json({ id: marked.id, enteredInError: { at: marked.enteredInErrorAt!.toISOString(), reason: marked.enteredInErrorReason! } }, HttpStatusCodes.OK);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};
