import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { ListedTransfer, ShownTransfer } from "@/lib/transfer-views";
import type { StockActor } from "@/lib/transfers";
import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import { AllocationError } from "@/lib/stock-allocation";
import { listTransfers as listAll, transferShown } from "@/lib/transfer-views";
import * as transfers from "@/lib/transfers";

import type {
  AcceptShortfallRoute,
  CancelTransferRoute,
  DeclineTransferRoute,
  GetTransferRoute,
  ListTransfersRoute,
  ReceiveTransferRoute,
  RequestTransferRoute,
  SendDirectRoute,
  SendTransferRoute,
} from "./stock-transfers.routes";

function actorOf(c: Context<TenantBindings>): StockActor {
  return { userId: c.var.user!.id, membershipId: c.var.membership.id, roles: c.var.membership.roles };
}

function refusal(c: Context, err: unknown) {
  if (err instanceof AllocationError)
    return c.json({ message: err.message, code: err.code, line: err.line }, HttpStatusCodes.CONFLICT);
  if (!(err instanceof transfers.TransferError))
    return null;
  if (err.code === "not_found")
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
  if (err.code === "ward_store_only")
    return c.json({ message: err.message, code: err.code }, HttpStatusCodes.FORBIDDEN);
  return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

function listedJson(t: ListedTransfer) {
  return { ...t, createdAt: t.createdAt.toISOString(), sentAt: iso(t.sentAt), receivedAt: iso(t.receivedAt) };
}

function transferJson(t: ShownTransfer) {
  const step = (s: { byName: string; at: Date } | null) => s && { byName: s.byName, at: s.at.toISOString() };
  return {
    ...listedJson(t),
    requested: step(t.requested),
    sent: step(t.sent),
    received: step(t.received),
    shortfallAccepted: step(t.shortfallAccepted),
    closed: t.closed && { byName: t.closed.byName, at: t.closed.at.toISOString(), reason: t.closed.reason },
  };
}

/** Runs a step, answering with the transfer as it then stands. */
async function answer(c: Context<TenantBindings>, act: () => Promise<{ id: string }>, status: 200 | 201 = HttpStatusCodes.OK) {
  try {
    const { id } = await act();
    return c.json(transferJson(await transferShown(c.var.db, id)), status);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused;
    throw err;
  }
}

export const listTransfers: TenantRouteHandler<ListTransfersRoute> = async (c) => {
  const { awaitingAcceptance, ...filter } = c.req.valid("query");
  return c.json({ transfers: (await listAll(c.var.db, { ...filter, awaitingAcceptance: awaitingAcceptance === "true" })).map(listedJson) }, HttpStatusCodes.OK);
};

export const getTransfer: TenantRouteHandler<GetTransferRoute> = async (c) => {
  const { id } = c.req.valid("param");
  return answer(c, async () => ({ id })) as never;
};

export const requestTransfer: TenantRouteHandler<RequestTransferRoute> = async (c) => {
  const body = c.req.valid("json");
  return answer(c, () => transfers.requestTransfer(c.var.db, c.var.facility.id, body, actorOf(c)), HttpStatusCodes.CREATED) as never;
};

export const sendDirect: TenantRouteHandler<SendDirectRoute> = async (c) => {
  const body = c.req.valid("json");
  return answer(c, () => transfers.sendDirect(c.var.db, c.var.facility.id, body, actorOf(c)), HttpStatusCodes.CREATED) as never;
};

export const sendTransfer: TenantRouteHandler<SendTransferRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { lines } = c.req.valid("json");
  return answer(c, () => transfers.sendTransfer(c.var.db, c.var.facility.id, id, lines, actorOf(c))) as never;
};

export const receiveTransfer: TenantRouteHandler<ReceiveTransferRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  return answer(c, () => transfers.receiveTransfer(c.var.db, c.var.facility.id, id, body, actorOf(c))) as never;
};

export const acceptShortfall: TenantRouteHandler<AcceptShortfallRoute> = async (c) => {
  const { id } = c.req.valid("param");
  return answer(c, () => transfers.acceptShortfall(c.var.db, c.var.facility.id, id, actorOf(c))) as never;
};

export const cancelTransfer: TenantRouteHandler<CancelTransferRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { reason } = c.req.valid("json");
  return answer(c, () => transfers.closeRequest(c.var.db, c.var.facility.id, id, "cancelled", reason, actorOf(c))) as never;
};

export const declineTransfer: TenantRouteHandler<DeclineTransferRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { reason } = c.req.valid("json");
  return answer(c, () => transfers.closeRequest(c.var.db, c.var.facility.id, id, "declined", reason, actorOf(c))) as never;
};
