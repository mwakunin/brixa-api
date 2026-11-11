import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { requireMembershipRole } from "@/middlewares/auth";
import { facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";

/**
 * Visits and admissions. Front desk and clinical staff open and close them;
 * every member may read them, and each read is audited.
 */
const tags = ["Encounters"];

/** Who opens, closes and cancels a visit. */
export const VISIT_STAFF = ["records_clerk", "nurse", "doctor", "clinical_officer", "facility_admin"] as const;
/** Who admits, transfers and discharges. */
export const WARD_STAFF = ["records_clerk", "nurse", "ward_nurse", "doctor", "clinical_officer", "facility_admin"] as const;

const visitStaff = requireMembershipRole(...VISIT_STAFF);
const wardStaff = requireMembershipRole(...WARD_STAFF);

const RefusalSchema = z.object({ message: z.string(), code: z.string() });
const DISPOSITIONS = ["home", "referred", "died", "absconded", "against_advice"] as const;

export const EncounterSchema = z.object({
  id: z.uuid(),
  patientId: z.uuid(),
  kind: z.enum(["opd", "emergency", "ipd"]),
  status: z.enum(["open", "closed", "cancelled"]),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  parentEncounterId: z.uuid().nullable(),
  /** The queue the patient is in now; null in none, and for an admission. */
  queue: z.object({
    entryId: z.uuid(),
    servicePointId: z.uuid(),
    servicePointName: z.string(),
    status: z.enum(["waiting", "serving"]),
    joinedAt: z.string(),
    servingAt: z.string().nullable(),
  }).nullable(),
  /** Whoever most recently saw the patient at a consultation point. */
  attending: z.object({ membershipId: z.uuid(), name: z.string() }).nullable(),
  admission: z.object({
    admissionNumber: z.string(),
    admittedAt: z.string(),
    dischargedAt: z.string().nullable(),
    dischargeDisposition: z.enum(DISPOSITIONS).nullable(),
    stays: z.array(z.object({
      bedId: z.uuid(),
      bedLabel: z.string(),
      wardName: z.string(),
      startedAt: z.string(),
      endedAt: z.string().nullable(),
    })),
  }).nullable(),
});

const IdParamsSchema = z.object({ id: z.uuid() });
const OpenBodySchema = z.object({
  patientId: z.uuid(),
  kind: z.enum(["opd", "emergency"]),
  /**
   * The service point the patient waits at first. Left out, they join the
   * facility's triage point if it has exactly one; `null` joins no queue
   * (a walk-in for the lab).
   */
  queueAt: z.uuid().nullable().optional(),
});
const CancelBodySchema = z.object({ reason: z.string().trim().min(3).max(200).regex(/^\P{C}+$/u, "One line") });
const AdmitBodySchema = z.object({
  patientId: z.uuid(),
  bedId: z.uuid(),
  /** The visit the admission followed, e.g. an emergency attendance. */
  parentEncounterId: z.uuid().optional(),
});
const TransferBodySchema = z.object({ bedId: z.uuid() });
const DischargeBodySchema = z.object({ disposition: z.enum(DISPOSITIONS) });
const ListQuerySchema = z.object({
  patientId: z.uuid(),
  /** Skip this many, for the next page. */
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const refusals = {
  [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible in the encounter's current state"),
};

function changeRoute<P extends string, B extends z.ZodType>(path: P, summary: string, body: B, middleware: typeof visitStaff) {
  return createRoute({
    tags,
    method: "post",
    path,
    summary,
    middleware: [middleware] as const,
    request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(body, "The change") },
    responses: {
      [HttpStatusCodes.OK]: jsonContent(EncounterSchema, "Done"),
      [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(body), "Invalid request"),
      ...refusals,
      ...tenantResponses,
    },
  });
}

export const openEncounter = createRoute({
  tags,
  method: "post",
  path: "/encounters",
  summary: "Open an outpatient visit or emergency attendance",
  middleware: [visitStaff] as const,
  request: { headers: facilityHeaders, body: jsonContentRequired(OpenBodySchema, "Who, and which kind") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(EncounterSchema, "Opened"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(OpenBodySchema), "Invalid request"),
    ...refusals,
    ...tenantResponses,
  },
});

export const listEncounters = createRoute({
  tags,
  method: "get",
  path: "/encounters",
  summary: "A patient's encounters",
  description: "Newest first, 100 at a time: pass `offset` for the next page. Audited as a read of the patient's record.",
  request: { headers: facilityHeaders, query: ListQuerySchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ encounters: z.array(EncounterSchema) }), "Encounters"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(ListQuerySchema), "Invalid request"),
    ...tenantResponses,
  },
});

export const getEncounter = createRoute({
  tags,
  method: "get",
  path: "/encounters/{id}",
  summary: "Open an encounter",
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(EncounterSchema, "The encounter"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not an encounter id"),
    ...tenantResponses,
  },
});

export const closeEncounter = createRoute({
  tags,
  method: "post",
  path: "/encounters/{id}/close",
  summary: "Close a visit",
  description: "An admission ends by discharge instead.",
  middleware: [visitStaff] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(EncounterSchema, "Closed"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not an encounter id"),
    ...refusals,
    ...tenantResponses,
  },
});

export const cancelEncounter = changeRoute("/encounters/{id}/cancel", "Cancel an encounter opened by mistake", CancelBodySchema, visitStaff);

export const admitPatient = createRoute({
  tags,
  method: "post",
  path: "/admissions",
  summary: "Admit a patient to a bed",
  description:
    "Opens an inpatient encounter, issues the patient's IP number if this is "
    + "their first admission, and issues an admission number.",
  middleware: [wardStaff] as const,
  request: { headers: facilityHeaders, body: jsonContentRequired(AdmitBodySchema, "Who, and which bed") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(EncounterSchema, "Admitted"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(AdmitBodySchema), "Invalid request"),
    ...refusals,
    ...tenantResponses,
  },
});

export const transferPatient = changeRoute("/encounters/{id}/transfer", "Move an admitted patient to another bed", TransferBodySchema, wardStaff);
export const dischargePatient = changeRoute("/encounters/{id}/discharge", "Discharge an admitted patient", DischargeBodySchema, wardStaff);

export type OpenEncounterRoute = typeof openEncounter;
export type ListEncountersRoute = typeof listEncounters;
export type GetEncounterRoute = typeof getEncounter;
export type CloseEncounterRoute = typeof closeEncounter;
export type CancelEncounterRoute = typeof cancelEncounter;
export type AdmitPatientRoute = typeof admitPatient;
export type TransferPatientRoute = typeof transferPatient;
export type DischargePatientRoute = typeof dischargePatient;
