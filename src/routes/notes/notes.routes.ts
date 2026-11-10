import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { CLINICAL_ROLES } from "@/lib/professions";
import { requireClinicalRole, requireMembershipRole } from "@/middlewares/auth";
import { facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";

/**
 * Clinical notes. Writing one is a clinical act under a current licence
 * (consultation notes by doctors, clinical officers and nurses; nursing notes
 * by nurses); reading signed notes is for clinical staff, and audited. A
 * draft is its author's alone.
 */
const tags = ["Clinical notes"];

/** Who writes notes at all; which kind each writes is checked per note (`NOTE_WRITERS`). */
export const NOTE_STAFF = ["doctor", "clinical_officer", "nurse", "ward_nurse"] as const;

const noteStaff = requireClinicalRole(...NOTE_STAFF);
const clinicalReaders = requireMembershipRole(...CLINICAL_ROLES);

const RefusalSchema = z.object({ message: z.string(), code: z.string() });
const IdParamsSchema = z.object({ id: z.uuid() });

/** A section: blank means not written. */
const section = z.string().max(10_000).optional();
const noteText = z.string().max(20_000);

const ContentSchema = z.object({
  presentingComplaint: section,
  history: section,
  examination: section,
  plan: section,
  /** A nursing note's text. */
  text: noteText.optional(),
});

const StartBodySchema = ContentSchema.extend({ kind: z.enum(["consultation", "nursing"]) });

const AuthorSchema = z.object({ membershipId: z.uuid(), name: z.string() });

const NoteSchema = z.object({
  id: z.uuid(),
  kind: z.enum(["consultation", "nursing"]),
  /** A draft is shown only to its author. */
  status: z.enum(["draft", "signed"]),
  presentingComplaint: z.string().nullable(),
  history: z.string().nullable(),
  examination: z.string().nullable(),
  plan: z.string().nullable(),
  text: z.string().nullable(),
  writtenBy: AuthorSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  signedAt: z.string().nullable(),
  enteredInError: z.object({ at: z.string(), reason: z.string() }).nullable(),
  addenda: z.array(z.object({
    id: z.uuid(),
    text: z.string(),
    writtenBy: AuthorSchema,
    signedAt: z.string(),
    enteredInError: z.object({ at: z.string(), reason: z.string() }).nullable(),
  })),
});

const refusals = {
  [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible in the note's or encounter's state"),
};

export const startNote = createRoute({
  tags,
  method: "post",
  path: "/encounters/{id}/notes",
  summary: "Start a note",
  description:
    "A draft on an open encounter: a consultation note (presenting complaint, "
    + "history, examination, plan; at least one) or a nursing note (text).",
  middleware: [noteStaff] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(StartBodySchema, "The note") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(NoteSchema, "Drafted"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(StartBodySchema), "Empty, or the wrong content for the kind"),
    ...tenantResponses,
  },
});

export const editDraft = createRoute({
  tags,
  method: "put",
  path: "/notes/{id}",
  summary: "Save a draft",
  description: "Replaces the draft's content. The author's alone, until it is signed or discarded.",
  middleware: [noteStaff] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(ContentSchema, "The whole note as it now reads") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(NoteSchema, "Saved"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(ContentSchema), "Empty, or the wrong content for the kind"),
    ...tenantResponses,
  },
});

export const signNote = createRoute({
  tags,
  method: "post",
  path: "/notes/{id}/sign",
  summary: "Sign a draft",
  description: "Freezes it. Also after the visit has closed.",
  middleware: [noteStaff] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(NoteSchema, "Signed"),
    ...refusals,
    ...tenantResponses,
  },
});

export const discardDraft = createRoute({
  tags,
  method: "post",
  path: "/notes/{id}/discard",
  summary: "Discard a draft",
  description: "It stays on the record, discarded, and is no longer shown.",
  middleware: [noteStaff] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ id: z.uuid(), status: z.literal("discarded") }), "Discarded"),
    ...refusals,
    ...tenantResponses,
  },
});

export const addAddendum = createRoute({
  tags,
  method: "post",
  path: "/notes/{id}/addenda",
  summary: "Add an addendum to a signed note",
  description: "How a signed note is corrected or added to. Written signed, and shown under the note.",
  middleware: [noteStaff] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(z.object({ text: noteText }), "The addendum") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(NoteSchema, "The note, with its addenda"),
    ...refusals,
    ...tenantResponses,
  },
});

export const markEnteredInError = createRoute({
  tags,
  method: "post",
  path: "/notes/{id}/entered-in-error",
  summary: "Mark a signed note or addendum entered in error",
  description: "For one written on the wrong patient's record. It stays on the record, marked, with the reason; an addendum is answered with its note.",
  middleware: [noteStaff] as const,
  request: {
    headers: facilityHeaders,
    params: IdParamsSchema,
    body: jsonContentRequired(z.object({ reason: z.string().trim().min(3).max(200).regex(/^\P{C}+$/u, "One line") }), "Why"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(NoteSchema, "Marked"),
    ...refusals,
    ...tenantResponses,
  },
});

export const listNotes = createRoute({
  tags,
  method: "get",
  path: "/encounters/{id}/notes",
  summary: "An encounter's notes",
  description: "Signed notes with their addenda, and your own drafts, in the order written. Audited.",
  middleware: [clinicalReaders] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ notes: z.array(NoteSchema) }), "Notes"),
    ...tenantResponses,
  },
});

export type StartNoteRoute = typeof startNote;
export type EditDraftRoute = typeof editDraft;
export type SignNoteRoute = typeof signNote;
export type DiscardDraftRoute = typeof discardDraft;
export type AddAddendumRoute = typeof addAddendum;
export type MarkEnteredInErrorRoute = typeof markEnteredInError;
export type ListNotesRoute = typeof listNotes;
