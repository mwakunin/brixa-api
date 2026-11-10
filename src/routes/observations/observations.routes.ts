import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { CLINICAL_ROLES } from "@/lib/professions";
import { VITAL_SIGN_CODES, VITAL_SIGNS } from "@/lib/vital-signs";
import { requireClinicalRole, requireMembershipRole } from "@/middlewares/auth";
import { facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";

/**
 * Vital signs on an encounter. Taking them is a clinical act, under a
 * current licence; reading them is for clinical staff, and audited.
 */
const tags = ["Vital signs"];

/** Who takes vital signs. */
export const VITALS_STAFF = ["doctor", "clinical_officer", "nurse", "ward_nurse"] as const;

const vitalsStaff = requireClinicalRole(...VITALS_STAFF);
const clinicalReaders = requireMembershipRole(...CLINICAL_ROLES);

const RefusalSchema = z.object({ message: z.string(), code: z.string() });
const IdParamsSchema = z.object({ id: z.uuid() });

const ReadingSchema = z.object({
  code: z.enum(VITAL_SIGN_CODES),
  /** In the sign's unit: °C, /min, mmHg, %, kg, cm, mmol/L, or a 0–10 score. */
  value: z.number(),
}).superRefine((reading, ctx) => {
  const range = VITAL_SIGNS[reading.code];
  if (!(reading.value >= range.min && reading.value <= range.max)) {
    ctx.addIssue({
      code: "custom",
      path: ["value"],
      message: `${range.label} must be between ${range.min} and ${range.max} ${range.unit}; check it was typed right`,
    });
  }
});

const RecordBodySchema = z.object({
  readings: z.array(ReadingSchema).min(1).max(VITAL_SIGN_CODES.length).refine(rs => new Set(rs.map(r => r.code)).size === rs.length, "Give each sign once").refine(rs => rs.some(r => r.code === "bp_systolic") === rs.some(r => r.code === "bp_diastolic"), "Blood pressure needs both readings"),
  /** When they were taken, if not just now: within the encounter, never in the future. */
  observedAt: z.iso.datetime({ offset: true }).optional(),
});

const ObservationSchema = z.object({
  id: z.uuid(),
  code: z.enum(VITAL_SIGN_CODES),
  label: z.string(),
  value: z.number(),
  unit: z.string(),
  observedAt: z.string(),
  recordedBy: z.object({ membershipId: z.uuid(), name: z.string() }),
  enteredInError: z.object({ at: z.string(), reason: z.string() }).nullable(),
});

const ErrorBodySchema = z.object({ reason: z.string().trim().min(3).max(200).regex(/^\P{C}+$/u, "One line") });

export const recordVitals = createRoute({
  tags,
  method: "post",
  path: "/encounters/{id}/observations",
  summary: "Record vital signs",
  description:
    "A set taken together, on an open encounter. A value outside what a real "
    + "reading can be is refused as a likely typing slip; it is not a judgement "
    + "of normal.",
  middleware: [vitalsStaff] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(RecordBodySchema, "The readings") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(z.object({ observations: z.array(ObservationSchema) }), "Recorded"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "The encounter is not open"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(RecordBodySchema), "A reading that cannot be real, or a time outside the encounter"),
    ...tenantResponses,
  },
});

export const listObservations = createRoute({
  tags,
  method: "get",
  path: "/encounters/{id}/observations",
  summary: "An encounter's vital signs",
  description: "Newest first, with readings entered in error marked. Audited.",
  middleware: [clinicalReaders] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ observations: z.array(ObservationSchema) }), "Readings"),
    ...tenantResponses,
  },
});

export const markEnteredInError = createRoute({
  tags,
  method: "post",
  path: "/observations/{id}/entered-in-error",
  summary: "Mark a reading entered in error",
  description: "The reading stays on the record, marked, with the reason. Record the right value as a new reading.",
  middleware: [vitalsStaff] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(ErrorBodySchema, "Why") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ id: z.uuid(), enteredInError: z.object({ at: z.string(), reason: z.string() }) }), "Marked"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Already marked"),
    ...tenantResponses,
  },
});

export type RecordVitalsRoute = typeof recordVitals;
export type ListObservationsRoute = typeof listObservations;
export type MarkEnteredInErrorRoute = typeof markEnteredInError;
