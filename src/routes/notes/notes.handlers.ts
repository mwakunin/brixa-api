import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import * as notes from "@/lib/notes";

import type {
  AddAddendumRoute,
  DiscardDraftRoute,
  EditDraftRoute,
  ListNotesRoute,
  MarkEnteredInErrorRoute,
  SignNoteRoute,
  StartNoteRoute,
} from "./notes.routes";

function actorOf(c: Context<TenantBindings>): notes.NoteActor {
  return { userId: c.var.user!.id, membershipId: c.var.membership.id, roles: c.var.membership.roles };
}

function refusal(c: Context, err: unknown) {
  if (!(err instanceof notes.NoteError))
    return null;
  if (err.code === "encounter_not_found" || err.code === "not_found")
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
  if (err.code === "not_your_kind")
    return c.json({ message: err.message, code: err.code }, HttpStatusCodes.FORBIDDEN);
  if (err.code === "empty") {
    return c.json({
      success: false as const,
      error: { name: "ValidationError", issues: [{ code: "custom" as const, path: [], message: err.message }] },
    }, HttpStatusCodes.UNPROCESSABLE_ENTITY);
  }
  return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
}

type Shown = NonNullable<Awaited<ReturnType<typeof notes.noteAsShown>>>;

function noteJson(n: Shown) {
  return {
    ...n,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
    signedAt: n.signedAt?.toISOString() ?? null,
    enteredInError: n.enteredInError && { at: n.enteredInError.at.toISOString(), reason: n.enteredInError.reason },
    addenda: n.addenda.map(a => ({ ...a, signedAt: a.signedAt.toISOString() })),
  };
}

/** Runs a change, answering with the note as the list shows it (an addendum shows its note), without a second audit entry. */
async function answer(c: Context<TenantBindings>, act: () => Promise<{ id: string }>, status: 200 | 201 = HttpStatusCodes.OK) {
  try {
    const changed = await act();
    return c.json(noteJson((await notes.noteAsShown(c.var.db, changed.id, actorOf(c)))!), status);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused;
    throw err;
  }
}

export const startNote: TenantRouteHandler<StartNoteRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  return answer(c, () => notes.startNote(c.var.db, c.var.facility.id, id, body, actorOf(c)), HttpStatusCodes.CREATED) as never;
};

export const editDraft: TenantRouteHandler<EditDraftRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  return answer(c, () => notes.editDraft(c.var.db, c.var.facility.id, id, body, actorOf(c))) as never;
};

export const signNote: TenantRouteHandler<SignNoteRoute> = async (c) => {
  const { id } = c.req.valid("param");
  return answer(c, () => notes.signNote(c.var.db, c.var.facility.id, id, actorOf(c))) as never;
};

export const discardDraft: TenantRouteHandler<DiscardDraftRoute> = async (c) => {
  const { id } = c.req.valid("param");
  try {
    await notes.discardDraft(c.var.db, c.var.facility.id, id, actorOf(c));
    return c.json({ id, status: "discarded" as const }, HttpStatusCodes.OK);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};

export const addAddendum: TenantRouteHandler<AddAddendumRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { text } = c.req.valid("json");
  return answer(c, () => notes.addAddendum(c.var.db, c.var.facility.id, id, text, actorOf(c)), HttpStatusCodes.CREATED) as never;
};

export const markEnteredInError: TenantRouteHandler<MarkEnteredInErrorRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { reason } = c.req.valid("json");
  return answer(c, () => notes.markNoteEnteredInError(c.var.db, c.var.facility.id, id, reason, actorOf(c))) as never;
};

export const listNotes: TenantRouteHandler<ListNotesRoute> = async (c) => {
  const { id } = c.req.valid("param");
  try {
    const listed = await notes.listNotes(c.var.db, c.var.facility.id, id, actorOf(c));
    return c.json({ notes: listed.map(noteJson) }, HttpStatusCodes.OK);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};
