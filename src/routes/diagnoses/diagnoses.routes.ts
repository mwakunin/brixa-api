import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { CLINICAL_ROLES } from "@/lib/professions";
import { requireClinicalRole, requireMembershipRole } from "@/middlewares/auth";
import { clinicalResponses, facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";

/**
 * Diagnoses, coded in ICD-11, and the code search they are picked from.
 * Diagnosing is a clinical act under a current licence; reading diagnoses is
 * for clinical staff, and audited.
 *
 * ICD-11: International Classification of Diseases, Eleventh Revision,
 * World Health Organization (WHO) 2019, https://icd.who.int/browse11,
 * licensed under CC BY-ND 3.0 IGO.
 */
const tags = ["Diagnoses"];

/** Who diagnoses: doctors, clinical officers, and nurses in nurse-led clinics. */
export const DIAGNOSING_STAFF = ["doctor", "clinical_officer", "nurse"] as const;

const diagnosingStaff = requireClinicalRole(...DIAGNOSING_STAFF);
const clinicalReaders = requireMembershipRole(...CLINICAL_ROLES);

const RefusalSchema = z.object({ message: z.string(), code: z.string() });
const IdParamsSchema = z.object({ id: z.uuid() });
const IcdCodeSchema = z.string().trim().toUpperCase().regex(/^[0-9A-Z]{4}(?:\.[0-9A-Z]{1,2})*$/, "An ICD-11 code, e.g. 1F40.Z");

const IcdMatchSchema = z.object({
  code: z.string(),
  title: z.string(),
  /** WHO's URI for the code, kept with it as WHO's licence requires. */
  uri: z.string(),
  /** "Other specified" or "unspecified". */
  residual: z.boolean(),
});

const DiagnosisSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  title: z.string(),
  uri: z.string(),
  /** The ICD-11 release the code was taken from. */
  release: z.string(),
  certainty: z.enum(["provisional", "confirmed"]),
  rank: z.enum(["principal", "secondary"]),
  diagnosedAt: z.string(),
  diagnosedBy: z.object({ membershipId: z.uuid(), name: z.string() }),
  confirmedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  endReason: z.enum(["ruled_out", "entered_in_error"]).nullable(),
});

const RecordBodySchema = z.object({
  code: IcdCodeSchema,
  certainty: z.enum(["provisional", "confirmed"]),
  /** Make it the principal diagnosis. The first one on an encounter is anyway. */
  principal: z.boolean().optional(),
});

const SearchQuerySchema = z.object({
  /** Words from the condition's name, or a code or its start. */
  q: z.string().trim().min(2).max(100),
});

const EndBodySchema = z.object({ reason: z.enum(["ruled_out", "entered_in_error"]) });

const refusals = {
  [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible in the diagnosis's or encounter's state"),
};

export const searchIcd = createRoute({
  tags,
  method: "get",
  path: "/icd-codes",
  summary: "Find an ICD-11 code",
  description:
    "By name (each word typed matches the start of a word in the title) or "
    + "by code. Only codes specific enough to record, from the current release. "
    + "At most 20. ICD-11 © WHO 2019, CC BY-ND 3.0 IGO.",
  middleware: [clinicalReaders] as const,
  request: { headers: facilityHeaders, query: SearchQuerySchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ codes: z.array(IcdMatchSchema) }), "Best first"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(SearchQuerySchema), "Too short"),
    ...tenantResponses,
  },
});

export const recordDiagnosis = createRoute({
  tags,
  method: "post",
  path: "/encounters/{id}/diagnoses",
  summary: "Record a diagnosis",
  description:
    "On an open encounter, provisional or confirmed. The first is the "
    + "principal diagnosis; a later one is secondary unless `principal` is set.",
  middleware: [diagnosingStaff] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(RecordBodySchema, "The diagnosis") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(DiagnosisSchema, "Recorded"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(RecordBodySchema), "Not a code that can be recorded"),
    ...clinicalResponses,
  },
});

export const listDiagnoses = createRoute({
  tags,
  method: "get",
  path: "/encounters/{id}/diagnoses",
  summary: "An encounter's diagnoses",
  description: "Standing ones first, principal before secondary; ended ones marked. Audited.",
  middleware: [clinicalReaders] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ diagnoses: z.array(DiagnosisSchema) }), "Diagnoses"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not an encounter id"),
    ...tenantResponses,
  },
});

function changeRoute<P extends string>(path: P, summary: string, description: string) {
  return createRoute({
    tags,
    method: "post",
    path,
    summary,
    description,
    middleware: [diagnosingStaff] as const,
    request: { headers: facilityHeaders, params: IdParamsSchema },
    responses: {
      [HttpStatusCodes.OK]: jsonContent(DiagnosisSchema, "Done"),
      ...refusals,
      [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not a diagnosis id"),
      ...clinicalResponses,
    },
  });
}

export const confirmDiagnosis = changeRoute(
  "/diagnoses/{id}/confirm",
  "Confirm a provisional diagnosis",
  "E.g. once a test bears it out; also after the visit has closed.",
);

export const makePrincipal = changeRoute(
  "/diagnoses/{id}/principal",
  "Make a diagnosis the principal one",
  "The previous principal diagnosis becomes secondary.",
);

export const endDiagnosis = createRoute({
  tags,
  method: "post",
  path: "/diagnoses/{id}/end",
  summary: "Rule out a diagnosis, or mark it entered in error",
  description: "It stays on the record, ended.",
  middleware: [diagnosingStaff] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(EndBodySchema, "Why") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(DiagnosisSchema, "Ended"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(EndBodySchema), "No such reason, or not an id"),
    ...clinicalResponses,
  },
});

export type SearchIcdRoute = typeof searchIcd;
export type RecordDiagnosisRoute = typeof recordDiagnosis;
export type ListDiagnosesRoute = typeof listDiagnoses;
export type ConfirmDiagnosisRoute = typeof confirmDiagnosis;
export type MakePrincipalRoute = typeof makePrincipal;
export type EndDiagnosisRoute = typeof endDiagnosis;
