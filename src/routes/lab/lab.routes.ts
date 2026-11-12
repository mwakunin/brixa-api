import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { CLINICAL_ROLES } from "@/lib/professions";
import { COLLECTING_STAFF, LAB_STAFF } from "@/lib/specimens";
import { requireClinicalRole, requireMembershipRole } from "@/middlewares/auth";
import { facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";

/**
 * The lab's specimens: the worklist, taking a specimen (the lab, or a nurse),
 * receiving, rejecting and recollecting it. Each is an act under a current
 * licence (rule 25); the worklist is audited, since it names patients.
 */
const tags = ["Lab"];

const collectors = requireClinicalRole(...COLLECTING_STAFF);
const labOnly = requireClinicalRole(...LAB_STAFF);
const clinicalReaders = requireMembershipRole(...CLINICAL_ROLES);

const RefusalSchema = z.object({ message: z.string(), code: z.string() });
const IdParamsSchema = z.object({ id: z.uuid() });

const SPECIMEN_TYPES = ["blood", "urine", "stool", "sputum", "swab", "csf", "body_fluid", "other"] as const;
const REJECTION_REASONS = ["haemolysed", "clotted", "insufficient", "wrong_container", "mislabelled", "leaked", "too_old", "other"] as const;

const PatientSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  opNumber: z.string().nullable(),
  sex: z.enum(["male", "female", "intersex"]).nullable(),
  ageYears: z.number().int(),
});

const TestSchema = z.object({
  orderItemId: z.uuid(),
  code: z.string(),
  name: z.string(),
  /** Not yet paid for at an outpatient visit: a warning, never a block. */
  unpaid: z.boolean(),
});

const SpecimenSchema = z.object({
  id: z.uuid(),
  accessionNumber: z.string(),
  orderId: z.uuid(),
  encounterId: z.uuid(),
  urgency: z.enum(["routine", "urgent"]),
  specimenType: z.enum(SPECIMEN_TYPES),
  status: z.enum(["collected", "received", "rejected"]),
  collectedAt: z.string(),
  collectedBy: z.object({ membershipId: z.uuid(), name: z.string() }),
  receivedAt: z.string().nullable(),
  rejectedAt: z.string().nullable(),
  rejectionReason: z.enum(REJECTION_REASONS).nullable(),
  rejectionNote: z.string().nullable(),
  /** The rejected specimen this one was taken again for. */
  recollectionOf: z.uuid().nullable(),
  patient: PatientSchema,
  tests: z.array(TestSchema),
});

const CollectionDueSchema = z.object({
  orderId: z.uuid(),
  encounterId: z.uuid(),
  urgency: z.enum(["routine", "urgent"]),
  orderedAt: z.string(),
  patient: PatientSchema,
  specimenType: z.enum(SPECIMEN_TYPES),
  tests: z.array(TestSchema),
});

const CollectBodySchema = z.object({
  specimenType: z.enum(SPECIMEN_TYPES),
  /** The tests it is for; every ordered test of this type on the order if left out. */
  orderItemIds: z.array(z.uuid()).min(1).max(30).optional(),
});

const RejectBodySchema = z.object({
  reason: z.enum(REJECTION_REASONS),
  /** Required for `other`. */
  note: z.string().trim().min(1).max(200).regex(/^\P{C}+$/u, "One line").optional(),
}).refine(b => b.reason !== "other" || b.note !== undefined, { message: "Say what was wrong", path: ["note"] });

const PersonSchema = z.object({ membershipId: z.uuid(), name: z.string() });

const ValueSchema = z.object({
  analyteId: z.uuid(),
  code: z.string(),
  name: z.string(),
  resultType: z.enum(["numeric", "choice", "text"]),
  value: z.union([z.number(), z.string()]),
  unit: z.string().nullable(),
  /** The reference range applied, as frozen with the value. */
  range: z.object({ low: z.number().nullable(), high: z.number().nullable() }).nullable(),
  flag: z.enum(["low", "high", "critical_low", "critical_high", "abnormal"]).nullable(),
});

const ResultSchema = z.object({
  id: z.uuid(),
  orderId: z.uuid(),
  orderItemId: z.uuid(),
  specimenId: z.uuid(),
  accessionNumber: z.string(),
  code: z.string(),
  name: z.string(),
  version: z.number().int(),
  correctionReason: z.string().nullable(),
  /** `entered` stays in the lab; `released` (unverified) and `verified` reach the clinician. */
  status: z.enum(["entered", "released", "verified", "superseded"]),
  enteredAt: z.string(),
  enteredBy: PersonSchema,
  releasedAt: z.string().nullable(),
  releaseReason: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  verifiedBy: PersonSchema.nullable(),
  hasCritical: z.boolean(),
  told: z.object({ name: z.string(), how: z.enum(["in_person", "phone"]), at: z.string() }).nullable(),
  values: z.array(ValueSchema),
});

const ToldSchema = z.object({
  /** Who was told: the clinician, or the ward. */
  name: z.string().trim().min(1).max(120).regex(/^\P{C}+$/u, "One line"),
  how: z.enum(["in_person", "phone"]),
  /** Now unless given. */
  at: z.iso.datetime({ offset: true }).optional(),
});

const EnterBodySchema = z.object({
  orderItemId: z.uuid(),
  values: z.array(z.object({ analyteId: z.uuid(), value: z.union([z.number().finite(), z.string().trim().min(1).max(2000)]) })).min(1).max(60),
  /** Why, when the test already has a result: this one corrects it. */
  correctionReason: z.string().trim().min(1).max(200).regex(/^\P{C}+$/u, "One line").optional(),
});

const ReleaseBodySchema = z.object({
  /** Why it goes out unverified, e.g. "Only lab member on night duty". */
  reason: z.string().trim().min(1).max(200).regex(/^\P{C}+$/u, "One line"),
  told: ToldSchema.optional(),
});

const VerifyBodySchema = z.object({ told: ToldSchema.optional() });

const refusals = {
  [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible in the specimen's or order's state"),
};

export const viewWorklist = createRoute({
  tags,
  method: "get",
  path: "/lab/worklist",
  summary: "The lab's worklist",
  description:
    "Tests waiting to be collected on open encounters (by order and specimen "
    + "type), specimens a nurse took that the lab has not received, "
    + "specimens in the lab with a test still to result, and results to "
    + "verify. Urgent first, then oldest. A test not yet paid "
    + "for at an outpatient visit is marked `unpaid`. Audited.",
  middleware: [labOnly] as const,
  request: { headers: facilityHeaders },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({
      toCollect: z.array(CollectionDueSchema),
      toReceive: z.array(SpecimenSchema),
      inLab: z.array(SpecimenSchema),
      toVerify: z.array(ResultSchema),
    }), "The worklist"),
    ...tenantResponses,
  },
});

export const collectSpecimen = createRoute({
  tags,
  method: "post",
  path: "/orders/{id}/specimens",
  summary: "Take a specimen",
  description:
    "For ordered lab tests of one specimen type on the order, which are then "
    + "done: no longer cancellable, their charges standing. It takes the "
    + "day's next accession number. Taken by the lab, it is received at once.",
  middleware: [collectors] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(CollectBodySchema, "What it is for") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(SpecimenSchema, "Taken"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(CollectBodySchema), "Invalid request"),
    ...tenantResponses,
  },
});

export const receiveSpecimen = createRoute({
  tags,
  method: "post",
  path: "/specimens/{id}/receive",
  summary: "Receive a specimen in the lab",
  middleware: [labOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(SpecimenSchema, "Received"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not a specimen id"),
    ...tenantResponses,
  },
});

export const rejectSpecimen = createRoute({
  tags,
  method: "post",
  path: "/specimens/{id}/reject",
  summary: "Reject a specimen",
  description: "For a reason from the list (`other` with a note). It keeps its number; recollect its tests on a new one.",
  middleware: [labOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(RejectBodySchema, "Why") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(SpecimenSchema, "Rejected"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(RejectBodySchema), "No such reason, or no note for other"),
    ...tenantResponses,
  },
});

export const recollectSpecimen = createRoute({
  tags,
  method: "post",
  path: "/specimens/{id}/recollect",
  summary: "Take a rejected specimen again",
  description: "A new specimen, with a new accession number, for the same tests.",
  middleware: [collectors] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(SpecimenSchema, "Taken again"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not a specimen id"),
    ...tenantResponses,
  },
});

export const enterResult = createRoute({
  tags,
  method: "post",
  path: "/specimens/{id}/results",
  summary: "Enter a test's result",
  description:
    "On a received specimen: every number and choice of the test, text "
    + "optional. Each value is flagged from the range for the patient's sex "
    + "and age at collection, and frozen with it. A test with a result is "
    + "corrected by entering again, with `correctionReason`: the old version "
    + "is superseded at once. It reaches the clinician once released or verified.",
  middleware: [labOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(EnterBodySchema, "The values") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(ResultSchema, "Entered"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(EnterBodySchema), "Invalid values"),
    ...tenantResponses,
  },
});

export const releaseResult = createRoute({
  tags,
  method: "post",
  path: "/lab-results/{id}/release",
  summary: "Release a result unverified",
  description:
    "For one lab member on duty: it reaches the clinician marked unverified, "
    + "for the next lab member to verify. A critical value needs `told`.",
  middleware: [labOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(ReleaseBodySchema, "Why") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(ResultSchema, "Released"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(ReleaseBodySchema), "No reason given"),
    ...tenantResponses,
  },
});

export const verifyResult = createRoute({
  tags,
  method: "post",
  path: "/lab-results/{id}/verify",
  summary: "Verify a result",
  description: "By a lab member other than the one who entered it. A critical value needs `told`, unless recorded at release.",
  middleware: [labOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(VerifyBodySchema, "Who was told, for a critical value") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(ResultSchema, "Verified"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(VerifyBodySchema), "Invalid request"),
    ...tenantResponses,
  },
});

export const listResults = createRoute({
  tags,
  method: "get",
  path: "/encounters/{id}/lab-results",
  summary: "An encounter's lab results",
  description: "Released and verified results, with each order's current printed report (`/documents/{id}/pdf`). Audited.",
  middleware: [clinicalReaders] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, query: z.object({ offset: z.coerce.number().int().min(0).default(0) }) },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({
      results: z.array(ResultSchema),
      reports: z.array(z.object({ orderId: z.uuid(), documentId: z.uuid(), number: z.string() })),
    }), "Results"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not an encounter id"),
    ...tenantResponses,
  },
});

export type ViewWorklistRoute = typeof viewWorklist;
export type EnterResultRoute = typeof enterResult;
export type ReleaseResultRoute = typeof releaseResult;
export type VerifyResultRoute = typeof verifyResult;
export type ListResultsRoute = typeof listResults;
export type CollectSpecimenRoute = typeof collectSpecimen;
export type ReceiveSpecimenRoute = typeof receiveSpecimen;
export type RejectSpecimenRoute = typeof rejectSpecimen;
export type RecollectSpecimenRoute = typeof recollectSpecimen;
