import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { queueEntries } from "@/db/schema";
import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import * as queues from "@/lib/queues";

import type {
  CreateServicePointRoute,
  FinishRoute,
  JoinQueueRoute,
  ListServicePointsRoute,
  RemoveFromQueueRoute,
  ServeRoute,
  UpdateServicePointRoute,
  ViewQueueRoute,
} from "./queues.routes";

const iso = (d: Date | null) => d?.toISOString() ?? null;

function actorOf(c: Context<TenantBindings>) {
  return { userId: c.var.user!.id, membershipId: c.var.membership.id };
}

export function entryJson(e: typeof queueEntries.$inferSelect) {
  return {
    id: e.id,
    encounterId: e.encounterId,
    servicePointId: e.servicePointId,
    status: e.status,
    joinedAt: e.joinedAt.toISOString(),
    servingAt: iso(e.servingAt),
    servedBy: e.servedBy,
    endedAt: iso(e.endedAt),
  };
}

function pointJson(p: { id: string; name: string; kind: "triage" | "consultation"; isActive: boolean }) {
  return { id: p.id, name: p.name, kind: p.kind, isActive: p.isActive };
}

/** A queue refusal, or null to let the error through. Shared with the encounters handlers, whose opening joins a queue. */
export function queueRefusal(c: Context, err: unknown) {
  if (!(err instanceof queues.QueueError))
    return null;
  if (queues.QUEUE_NOT_FOUND.has(err.code))
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
  return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
}

async function answer<T>(c: Context<TenantBindings>, act: () => Promise<T>, json: (result: T) => object, status: 200 | 201 = HttpStatusCodes.OK) {
  try {
    return c.json(json(await act()), status);
  }
  catch (err) {
    const refused = queueRefusal(c, err);
    if (refused)
      return refused;
    throw err;
  }
}

export const listServicePoints: TenantRouteHandler<ListServicePointsRoute> = async (c) => {
  return c.json({ servicePoints: await queues.listServicePoints(c.var.db) }, HttpStatusCodes.OK);
};

export const createServicePoint: TenantRouteHandler<CreateServicePointRoute> = async (c) => {
  const body = c.req.valid("json");
  return answer(c, () => queues.createServicePoint(c.var.db, c.var.facility.id, body, actorOf(c)), pointJson, HttpStatusCodes.CREATED) as never;
};

export const updateServicePoint: TenantRouteHandler<UpdateServicePointRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  return answer(c, () => queues.updateServicePoint(c.var.db, c.var.facility.id, id, body, actorOf(c)), pointJson) as never;
};

export const viewQueue: TenantRouteHandler<ViewQueueRoute> = async (c) => {
  const { id } = c.req.valid("param");
  return answer(c, () => queues.viewQueue(c.var.db, c.var.facility.id, id, actorOf(c)), view => ({
    servicePoint: view.servicePoint,
    entries: view.entries.map(e => ({ ...e, joinedAt: e.joinedAt.toISOString(), servingAt: iso(e.servingAt) })),
  })) as never;
};

export const joinQueue: TenantRouteHandler<JoinQueueRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { servicePointId } = c.req.valid("json");
  return answer(c, () => queues.joinQueue(c.var.db, c.var.facility.id, id, servicePointId, actorOf(c)), entryJson, HttpStatusCodes.CREATED) as never;
};

export const serve: TenantRouteHandler<ServeRoute> = async (c) => {
  const { id } = c.req.valid("param");
  return answer(c, () => queues.serve(c.var.db, c.var.facility.id, id, actorOf(c)), entryJson) as never;
};

export const finish: TenantRouteHandler<FinishRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { nextServicePointId } = c.req.valid("json");
  return answer(c, () => queues.finish(c.var.db, c.var.facility.id, id, nextServicePointId, actorOf(c)), r => ({
    finished: entryJson(r.finished),
    next: r.next && entryJson(r.next),
  })) as never;
};

export const removeFromQueue: TenantRouteHandler<RemoveFromQueueRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { outcome } = c.req.valid("json");
  return answer(c, () => queues.removeFromQueue(c.var.db, c.var.facility.id, id, outcome, actorOf(c)), entryJson) as never;
};
