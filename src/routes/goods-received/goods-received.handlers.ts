import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { ShownNote } from "@/lib/goods-received";
import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import * as goods from "@/lib/goods-received";

import type { GetNoteRoute, ListNotesRoute, ReceiveGoodsRoute, ReverseBatchRoute } from "./goods-received.routes";

function actorOf(c: Context<TenantBindings>) {
  return { userId: c.var.user!.id, membershipId: c.var.membership.id };
}

const NOT_FOUND = new Set<goods.GoodsReceivedErrorCode>(["not_found", "batch_not_found"]);

function refusal(c: Context, err: unknown) {
  if (!(err instanceof goods.GoodsReceivedError))
    return null;
  if (NOT_FOUND.has(err.code))
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
  return c.json({ message: err.message, code: err.code, ...(err.line === undefined ? {} : { line: err.line }) }, HttpStatusCodes.CONFLICT);
}

function listedJson(note: goods.ListedNote) {
  return { ...note, createdAt: note.createdAt.toISOString() };
}

function noteJson(note: ShownNote) {
  return {
    ...listedJson(note),
    items: note.items.map(i => ({ ...i, reversal: i.reversal && { at: i.reversal.at.toISOString(), reason: i.reversal.reason } })),
  };
}

export const receiveGoods: TenantRouteHandler<ReceiveGoodsRoute> = async (c) => {
  const body = c.req.valid("json");
  try {
    const { note, warnings } = await goods.receiveGoods(c.var.db, c.var.facility.id, body, actorOf(c));
    return c.json({ ...noteJson(await goods.noteShown(c.var.db, note.id)), warnings }, HttpStatusCodes.CREATED);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};

export const listNotes: TenantRouteHandler<ListNotesRoute> = async (c) => {
  const filter = c.req.valid("query");
  return c.json({ notes: (await goods.listNotes(c.var.db, filter)).map(listedJson) }, HttpStatusCodes.OK);
};

export const getNote: TenantRouteHandler<GetNoteRoute> = async (c) => {
  const { id } = c.req.valid("param");
  try {
    return c.json(noteJson(await goods.noteShown(c.var.db, id)), HttpStatusCodes.OK);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};

export const reverseBatch: TenantRouteHandler<ReverseBatchRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { reason } = c.req.valid("json");
  try {
    const noteId = await goods.reverseBatch(c.var.db, c.var.facility.id, id, reason, actorOf(c));
    return c.json(noteJson(await goods.noteShown(c.var.db, noteId)), HttpStatusCodes.OK);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};
