import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { CLINICAL_ROLES } from "@/lib/professions";
import { requireClinicalRole, requireMembershipRole } from "@/middlewares/auth";
import { facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";

/**
 * A patient's allergies, or "no known allergies". Recorded by licensed
 * clinical and pharmacy staff; read by clinical staff, and audited.
 */
const tags = ["Allergies"];

/** Who records and removes allergies. */
export const ALLERGY_STAFF = ["doctor", "clinical_officer", "nurse", "ward_nurse", "pharmacist", "pharm_tech"] as const;

const allergyStaff = requireClinicalRole(...ALLERGY_STAFF);
const clinicalReaders = requireMembershipRole(...CLINICAL_ROLES);

const RefusalSchema = z.object({ message: z.string(), code: z.string() });
const IdParamsSchema = z.object({ id: z.uuid() });
const oneLine = (max: number) => z.string().trim().min(1).max(max).regex(/^\P{C}+$/u, "One line");

const AllergySchema = z.object({
  id: z.uuid(),
  category: z.enum(["drug", "food", "environment", "other", "none_known"]),
  /** Null for "no known allergies". */
  allergen: z.string().nullable(),
  /** The catalogue drug a drug allergy is to, when one was named. */
  drugCode: z.string().nullable(),
  reaction: z.string().nullable(),
  severity: z.enum(["mild", "moderate", "severe"]).nullable(),
  recordedAt: z.string(),
  recordedBy: z.object({ membershipId: z.uuid(), name: z.string() }),
  removedAt: z.string().nullable(),
  removalReason: z.enum(["entered_in_error", "no_longer_applies"]).nullable(),
});

const RecordBodySchema = z.union([
  z.object({
    category: z.enum(["drug", "food", "environment", "other"]),
    /** As the patient or their record says it, e.g. "Penicillin", "Groundnuts". */
    allergen: oneLine(100),
    /** For a drug allergy, the catalogue drug when one fits: prescribing it is then checked. */
    drugCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9._/-]{0,31}$/, "A drug catalogue code").optional(),
    reaction: oneLine(200).optional(),
    severity: z.enum(["mild", "moderate", "severe"]).optional(),
  }).refine(b => b.drugCode === undefined || b.category === "drug", { message: "Only a drug allergy names a drug", path: ["drugCode"] }),
  /** Asked, and the patient has none. Refused while an allergy stands. */
  z.object({ noKnownAllergies: z.literal(true) }),
]);

const ListQuerySchema = z.object({
  /** Include allergies ended as entered in error or no longer applying. */
  includeEnded: z.enum(["true", "false"]).default("false").transform(v => v === "true"),
});

const RemoveBodySchema = z.object({ reason: z.enum(["entered_in_error", "no_longer_applies"]) });

export const listAllergies = createRoute({
  tags,
  method: "get",
  path: "/patients/{id}/allergies",
  summary: "A patient's allergies",
  description: "Standing allergies, or a standing \"no known allergies\"; an empty list means nobody has asked yet. Audited.",
  middleware: [clinicalReaders] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, query: ListQuerySchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ allergies: z.array(AllergySchema) }), "Oldest first"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(ListQuerySchema), "Not a patient id, or an invalid filter"),
    ...tenantResponses,
  },
});

export const recordAllergy = createRoute({
  tags,
  method: "post",
  path: "/patients/{id}/allergies",
  summary: "Record an allergy, or no known allergies",
  description: "Recording an allergy ends a standing \"no known allergies\".",
  middleware: [allergyStaff] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(RecordBodySchema, "The allergy") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(AllergySchema, "Recorded"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "\"No known allergies\" while an allergy stands"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(RecordBodySchema), "Invalid allergy, or a `drugCode` not in the catalogue"),
    ...tenantResponses,
  },
});

export const removeAllergy = createRoute({
  tags,
  method: "post",
  path: "/allergies/{id}/remove",
  summary: "Remove an allergy",
  description: "Entered in error, or no longer applying. It stays on the record, ended.",
  middleware: [allergyStaff] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(RemoveBodySchema, "Why") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(AllergySchema, "Removed"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Already removed"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(RemoveBodySchema), "No such reason, or not an id"),
    ...tenantResponses,
  },
});

export type ListAllergiesRoute = typeof listAllergies;
export type RecordAllergyRoute = typeof recordAllergy;
export type RemoveAllergyRoute = typeof removeAllergy;
