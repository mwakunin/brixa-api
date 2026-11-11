import { and, asc, eq, isNull, ne, or } from "drizzle-orm";

import type { AppDb } from "@/db";
import type { MembershipRole } from "@/db/schema";

import { clinicalNotes, encounters, memberships, user } from "@/db/schema";

import type { PatientActor } from "./patients";

import { recordAudit } from "./audit";

/**
 * Clinical notes (SCHEMA.md §8, P3 slice 3b). A note is the author's draft
 * until signed, and frozen once signed (rule 19): corrected by an addendum,
 * or, if written on the wrong patient's record, marked entered in error. A
 * draft is the author's alone: to anyone else it does not exist.
 *
 * Note text is patient data: it is stored here and nowhere else, never in an
 * audit summary or a log line (rule 10).
 */

type NoteRow = typeof clinicalNotes.$inferSelect;
export type NoteKind = "consultation" | "nursing";

/** Who writes which kind of note. Any of them adds an addendum or marks a note entered in error. */
export const NOTE_WRITERS: Record<NoteKind, readonly MembershipRole[]> = {
  consultation: ["doctor", "clinical_officer", "nurse"],
  nursing: ["nurse", "ward_nurse"],
};

export interface Sections {
  presentingComplaint?: string;
  history?: string;
  examination?: string;
  plan?: string;
}

/** A note's content: the sections of a consultation note, or a nursing note's text. */
export type NoteContent = Sections & { text?: string };

export type NoteErrorCode
  = | "encounter_not_found"
    | "not_open"
    | "encounter_cancelled"
    | "not_found"
    | "not_your_kind"
    | "empty"
    | "not_a_draft"
    | "not_signed"
    | "entered_in_error";

export class NoteError extends Error {
  constructor(readonly code: NoteErrorCode) {
    super({
      encounter_not_found: "No such encounter",
      not_open: "A note is started on an open encounter",
      encounter_cancelled: "This encounter was cancelled",
      not_found: "No such note",
      not_your_kind: "Your roles do not write this kind of note",
      empty: "A consultation note needs at least one section, a nursing note or an addendum its text",
      not_a_draft: "This note is already signed or discarded; add an addendum instead",
      not_signed: "Only a signed note takes an addendum or is marked entered in error",
      entered_in_error: "This note is marked entered in error",
    }[code]);
    this.name = "NoteError";
  }
}

export interface NoteActor extends PatientActor {
  roles: readonly MembershipRole[];
}

const SECTIONS = ["presentingComplaint", "history", "examination", "plan"] as const;

/** The columns a note's content fills, every other content column cleared. Refuses content that does not fit the kind. */
function contentColumns(kind: NoteKind, content: NoteContent) {
  const sections = Object.fromEntries(SECTIONS.map(s => [s, content[s]?.trim() || null])) as Record<(typeof SECTIONS)[number], string | null>;
  const text = content.text?.trim() || null;
  if (kind === "consultation") {
    if (text || SECTIONS.every(s => !sections[s]))
      throw new NoteError("empty");
    return { ...sections, text: null };
  }
  if (!text || SECTIONS.some(s => sections[s]))
    throw new NoteError("empty");
  return { presentingComplaint: null, history: null, examination: null, plan: null, text };
}

async function encounterStatus(tx: AppDb, encounterId: string) {
  const [encounter] = await tx
    .select({ status: encounters.status })
    .from(encounters)
    .where(eq(encounters.id, encounterId))
    .for("share")
    .limit(1);
  if (!encounter)
    throw new NoteError("encounter_not_found");
  return encounter.status;
}

/**
 * The note, locked, after its encounter's share lock (M8). Someone else's
 * draft is answered as not found: a draft is its author's alone.
 */
async function lockNote(tx: AppDb, noteId: string, actor: PatientActor): Promise<NoteRow> {
  const [found] = await tx.select({ encounterId: clinicalNotes.encounterId }).from(clinicalNotes).where(eq(clinicalNotes.id, noteId)).limit(1);
  if (!found)
    throw new NoteError("not_found");
  if (await encounterStatus(tx, found.encounterId) === "cancelled")
    throw new NoteError("encounter_cancelled");
  const [note] = await tx.select().from(clinicalNotes).where(eq(clinicalNotes.id, noteId)).for("update").limit(1);
  if (note.status === "draft" && note.writtenBy !== actor.membershipId)
    throw new NoteError("not_found");
  return note;
}

/** Writing or signing a note's content takes a role that writes its kind, held now, not only when the draft was started. */
function mayWrite(actor: NoteActor, kind: NoteKind): void {
  if (!actor.roles.some(r => NOTE_WRITERS[kind].includes(r)))
    throw new NoteError("not_your_kind");
}

async function audit(tx: AppDb, facilityId: string, actor: PatientActor, action: Parameters<typeof recordAudit>[1]["action"], note: Pick<NoteRow, "id" | "encounterId" | "kind">, summary: string, extra: Record<string, unknown> = {}) {
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action,
    entityType: "encounter",
    entityId: note.encounterId,
    summary,
    detail: { noteId: note.id, kind: note.kind, ...extra },
  });
}

/** Starts a draft on an open encounter. */
export async function startNote(
  tx: AppDb,
  facilityId: string,
  encounterId: string,
  input: NoteContent & { kind: NoteKind },
  actor: NoteActor,
  now = new Date(),
): Promise<NoteRow> {
  if (await encounterStatus(tx, encounterId) !== "open")
    throw new NoteError("not_open");
  mayWrite(actor, input.kind);

  const [note] = await tx.insert(clinicalNotes).values({
    facilityId,
    encounterId,
    kind: input.kind,
    ...contentColumns(input.kind, input),
    status: "draft",
    writtenBy: actor.membershipId,
    createdAt: now,
    updatedAt: now,
  }).returning();
  await audit(tx, facilityId, actor, "note.drafted", note, `Started a ${input.kind} note`);
  return note;
}

/** Replaces a draft's content: the author's alone, while it is a draft and they still write its kind. */
export async function editDraft(tx: AppDb, facilityId: string, noteId: string, content: NoteContent, actor: NoteActor, now = new Date()): Promise<NoteRow> {
  const current = await lockNote(tx, noteId, actor);
  if (current.status !== "draft")
    throw new NoteError("not_a_draft");
  mayWrite(actor, current.kind as NoteKind);

  const [edited] = await tx.update(clinicalNotes)
    .set({ ...contentColumns(current.kind as NoteKind, content), updatedAt: now })
    .where(eq(clinicalNotes.id, noteId))
    .returning();
  await audit(tx, facilityId, actor, "note.edited", current, `Edited a draft ${current.kind} note`);
  return edited;
}

/**
 * Signs a draft, freezing it. Also after the visit has closed, but only while
 * the author still writes its kind. Discarding needs no such role.
 */
export async function signNote(tx: AppDb, facilityId: string, noteId: string, actor: NoteActor, now = new Date()): Promise<NoteRow> {
  const current = await lockNote(tx, noteId, actor);
  if (current.status !== "draft")
    throw new NoteError("not_a_draft");
  mayWrite(actor, current.kind as NoteKind);

  const [signed] = await tx.update(clinicalNotes).set({ status: "signed", signedAt: now }).where(eq(clinicalNotes.id, noteId)).returning();
  await audit(tx, facilityId, actor, "note.signed", current, `Signed a ${current.kind} note`);
  return signed;
}

/** Discards a draft. It stays on the record, discarded, and is no longer shown. */
export async function discardDraft(tx: AppDb, facilityId: string, noteId: string, actor: PatientActor, now = new Date()): Promise<NoteRow> {
  const current = await lockNote(tx, noteId, actor);
  if (current.status !== "draft")
    throw new NoteError("not_a_draft");

  const [discarded] = await tx.update(clinicalNotes).set({ status: "discarded", discardedAt: now }).where(eq(clinicalNotes.id, noteId)).returning();
  await audit(tx, facilityId, actor, "note.discarded", current, `Discarded a draft ${current.kind} note`);
  return discarded;
}

/** Adds a signed addendum to a signed note: how a signed note is corrected or added to. */
export async function addAddendum(tx: AppDb, facilityId: string, noteId: string, text: string, actor: PatientActor, now = new Date()): Promise<NoteRow> {
  const original = await lockNote(tx, noteId, actor);
  if (original.status !== "signed" || original.kind === "addendum")
    throw new NoteError("not_signed");
  if (original.enteredInErrorAt)
    throw new NoteError("entered_in_error");
  if (!text.trim())
    throw new NoteError("empty");

  const [addendum] = await tx.insert(clinicalNotes).values({
    facilityId,
    encounterId: original.encounterId,
    kind: "addendum",
    addendumOf: original.id,
    text: text.trim(),
    status: "signed",
    writtenBy: actor.membershipId,
    createdAt: now,
    updatedAt: now,
    signedAt: now,
  }).returning();
  await audit(tx, facilityId, actor, "note.addendum_added", original, `Added an addendum to a ${original.kind} note`, { addendumId: addendum.id });
  return addendum;
}

/**
 * Marks a signed note entered in error (the wrong patient's record), for a
 * stated reason. It stays on the record, marked. An addendum may be marked
 * too, e.g. one added to the wrong patient's note: it stays under its note,
 * shown marked.
 */
export async function markNoteEnteredInError(tx: AppDb, facilityId: string, noteId: string, reason: string, actor: PatientActor, now = new Date()): Promise<NoteRow> {
  const current = await lockNote(tx, noteId, actor);
  if (current.status !== "signed")
    throw new NoteError("not_signed");
  if (current.enteredInErrorAt)
    throw new NoteError("entered_in_error");

  const [marked] = await tx.update(clinicalNotes)
    .set({ enteredInErrorAt: now, enteredInErrorBy: actor.membershipId, enteredInErrorReason: reason })
    .where(eq(clinicalNotes.id, noteId))
    .returning();
  await audit(tx, facilityId, actor, "note.entered_in_error", current, `Marked a ${current.kind} note entered in error`, { reason });
  return marked;
}

/** Whether a draft, or a signed note not marked entered in error, stands on the encounter. */
export async function hasStandingNotes(tx: AppDb, encounterId: string): Promise<boolean> {
  const [row] = await tx.select({ id: clinicalNotes.id }).from(clinicalNotes).where(and(
    eq(clinicalNotes.encounterId, encounterId),
    ne(clinicalNotes.kind, "addendum"),
    or(eq(clinicalNotes.status, "draft"), and(eq(clinicalNotes.status, "signed"), isNull(clinicalNotes.enteredInErrorAt))),
  )).limit(1);
  return Boolean(row);
}

export interface NoteAuthor {
  membershipId: string;
  name: string;
}

export interface EnteredInError {
  at: Date;
  reason: string;
}

/** An addendum, as shown under its note. */
export interface ShownAddendum {
  id: string;
  text: string;
  writtenBy: NoteAuthor;
  signedAt: Date;
  enteredInError: EnteredInError | null;
}

/** A note as a reader sees it: a signed note, or the reader's own draft, with its addenda. */
export interface ShownNote {
  id: string;
  kind: NoteKind;
  status: "draft" | "signed";
  presentingComplaint: string | null;
  history: string | null;
  examination: string | null;
  plan: string | null;
  text: string | null;
  writtenBy: NoteAuthor;
  createdAt: Date;
  updatedAt: Date;
  signedAt: Date | null;
  enteredInError: EnteredInError | null;
  addenda: ShownAddendum[];
}

/**
 * An encounter's notes as `reader` sees them: every signed note with its
 * addenda, and the reader's own drafts, in the order written. Not audited.
 */
export async function notesOf(tx: AppDb, encounterId: string, reader: PatientActor): Promise<ShownNote[]> {
  const rows = await tx
    .select({ note: clinicalNotes, writtenByName: user.name })
    .from(clinicalNotes)
    .innerJoin(memberships, eq(memberships.id, clinicalNotes.writtenBy))
    .innerJoin(user, eq(user.id, memberships.userId))
    .where(and(
      eq(clinicalNotes.encounterId, encounterId),
      or(eq(clinicalNotes.status, "signed"), and(eq(clinicalNotes.status, "draft"), eq(clinicalNotes.writtenBy, reader.membershipId))),
    ))
    .orderBy(asc(clinicalNotes.createdAt), asc(clinicalNotes.id));

  const shown = rows.map(({ note: n, writtenByName }) => ({
    id: n.id,
    kind: n.kind,
    addendumOf: n.addendumOf,
    status: n.status as "draft" | "signed",
    presentingComplaint: n.presentingComplaint,
    history: n.history,
    examination: n.examination,
    plan: n.plan,
    text: n.text,
    writtenBy: { membershipId: n.writtenBy, name: writtenByName },
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    signedAt: n.signedAt,
    enteredInError: n.enteredInErrorAt ? { at: n.enteredInErrorAt, reason: n.enteredInErrorReason! } : null,
  }));
  const addenda = shown.filter(n => n.kind === "addendum");
  return shown
    .filter(n => n.kind !== "addendum")
    .map(({ addendumOf: _, ...note }) => ({
      ...note,
      kind: note.kind as NoteKind,
      addenda: addenda.filter(a => a.addendumOf === note.id).map(a => ({
        id: a.id,
        text: a.text!,
        writtenBy: a.writtenBy,
        signedAt: a.signedAt!,
        enteredInError: a.enteredInError,
      })),
    }));
}

/** As `notesOf`, with an audit entry: they are part of the record (rule 9). */
export async function listNotes(tx: AppDb, facilityId: string, encounterId: string, actor: PatientActor): Promise<ShownNote[]> {
  const [encounter] = await tx.select({ id: encounters.id }).from(encounters).where(eq(encounters.id, encounterId)).limit(1);
  if (!encounter)
    throw new NoteError("encounter_not_found");

  const listed = await notesOf(tx, encounterId, actor);
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "encounter.viewed",
    entityType: "encounter",
    entityId: encounterId,
    summary: `Viewed clinical notes (${listed.length})`,
  });
  return listed;
}

/** One note as `reader` sees it, for answering a write. */
export async function noteAsShown(tx: AppDb, noteId: string, reader: PatientActor): Promise<ShownNote | null> {
  const [note] = await tx.select({ encounterId: clinicalNotes.encounterId, addendumOf: clinicalNotes.addendumOf }).from(clinicalNotes).where(eq(clinicalNotes.id, noteId)).limit(1);
  const rootId = note.addendumOf ?? noteId;
  return (await notesOf(tx, note.encounterId, reader)).find(n => n.id === rootId) ?? null;
}
