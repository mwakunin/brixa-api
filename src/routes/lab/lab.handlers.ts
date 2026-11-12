import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { OrderActor } from "@/lib/orders";
import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import * as results from "@/lib/lab-results";
import * as lab from "@/lib/specimens";

import type {
  CollectSpecimenRoute,
  EnterResultRoute,
  ListResultsRoute,
  ReceiveSpecimenRoute,
  RecollectSpecimenRoute,
  RejectSpecimenRoute,
  ReleaseResultRoute,
  VerifyResultRoute,
  ViewWorklistRoute,
} from "./lab.routes";

function actorOf(c: Context<TenantBindings>): OrderActor {
  return { userId: c.var.user!.id, membershipId: c.var.membership.id, roles: c.var.membership.roles };
}

const NOT_FOUND = new Set(["order_not_found", "not_found", "specimen_not_found"]);

function refusal(c: Context, err: unknown) {
  if (!(err instanceof lab.SpecimenError) && !(err instanceof results.LabResultError))
    return null;
  if (NOT_FOUND.has(err.code))
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
  return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
}

function iso(d: Date | null) {
  return d ? d.toISOString() : null;
}

function specimenJson(s: lab.ShownSpecimen) {
  return { ...s, collectedAt: s.collectedAt.toISOString(), receivedAt: iso(s.receivedAt), rejectedAt: iso(s.rejectedAt) };
}

function resultJson(r: results.ShownResult) {
  return {
    ...r,
    enteredAt: r.enteredAt.toISOString(),
    releasedAt: iso(r.releasedAt),
    verifiedAt: iso(r.verifiedAt),
    told: r.told ? { ...r.told, at: r.told.at.toISOString() } : null,
  };
}

/** Runs a change to a result, answering with it as the worklist shows it. */
async function answerResult(c: Context<TenantBindings>, act: () => Promise<{ id: string }>, status: 200 | 201 = HttpStatusCodes.OK) {
  try {
    const changed = await act();
    return c.json(resultJson(await results.resultShown(c.var.db, changed.id)), status);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused;
    throw err;
  }
}

function toldOf(told: { name: string; how: results.ToldHow; at?: string } | undefined): results.Told | undefined {
  return told ? { name: told.name, how: told.how, at: told.at ? new Date(told.at) : undefined } : undefined;
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
    toVerify: list.toVerify.map(resultJson),
  }, HttpStatusCodes.OK);
};

export const enterResult: TenantRouteHandler<EnterResultRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  return answerResult(c, () => results.enterResult(c.var.db, c.var.facility.id, id, body, actorOf(c)), HttpStatusCodes.CREATED) as never;
};

export const releaseResult: TenantRouteHandler<ReleaseResultRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { reason, told } = c.req.valid("json");
  return answerResult(c, () => results.releaseResult(c.var.db, c.var.facility.id, id, { reason, told: toldOf(told) }, actorOf(c))) as never;
};

export const verifyResult: TenantRouteHandler<VerifyResultRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { told } = c.req.valid("json");
  return answerResult(c, () => results.verifyResult(c.var.db, c.var.facility.id, id, { told: toldOf(told) }, actorOf(c))) as never;
};

export const listResults: TenantRouteHandler<ListResultsRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const listed = await results.listResults(c.var.db, c.var.facility.id, id, actorOf(c));
  if (!listed)
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
  return c.json({ results: listed.results.map(resultJson), reports: listed.reports }, HttpStatusCodes.OK);
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
