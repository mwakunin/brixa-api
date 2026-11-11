import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { COLLECTING_STAFF, LAB_STAFF } from "@/lib/specimens";
import { requireClinicalRole } from "@/middlewares/auth";
import { facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";

/**
 * The lab's specimens: the worklist, taking a specimen (the lab, or a nurse),
 * receiving, rejecting and recollecting it. Each is an act under a current
 * licence (rule 25); the worklist is audited, since it names patients.
 */
const tags = ["Lab"];

const collectors = requireClinicalRole(...COLLECTING_STAFF);
const labOnly = requireClinicalRole(...LAB_STAFF);

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
    + "type), specimens a nurse took that the lab has not received, and "
    + "specimens in the lab. Urgent first, then oldest. A test not yet paid "
    + "for at an outpatient visit is marked `unpaid`. Audited.",
  middleware: [labOnly] as const,
  request: { headers: facilityHeaders },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({
      toCollect: z.array(CollectionDueSchema),
      toReceive: z.array(SpecimenSchema),
      inLab: z.array(SpecimenSchema),
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

export type ViewWorklistRoute = typeof viewWorklist;
export type CollectSpecimenRoute = typeof collectSpecimen;
export type ReceiveSpecimenRoute = typeof receiveSpecimen;
export type RejectSpecimenRoute = typeof rejectSpecimen;
export type RecollectSpecimenRoute = typeof recollectSpecimen;
