import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { requireClinicalRole, requireMembershipRole } from "@/middlewares/auth";
import { clinicalResponses, facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";

/**
 * Service points and their queues: triage and the clinics. The facility admin
 * sets the points up; front desk and clinical staff move patients through
 * them; only a licensed clinician calls a patient in and finishes with them.
 */
const tags = ["Queues"];

/** Who sees queues and moves patients into and out of them. */
export const QUEUE_STAFF = ["records_clerk", "nurse", "ward_nurse", "doctor", "clinical_officer", "facility_admin"] as const;
/** Who calls a patient in and sees them: an act under their licence. */
export const SERVING_STAFF = ["doctor", "clinical_officer", "nurse", "ward_nurse"] as const;

const adminOnly = requireMembershipRole("facility_admin");
const queueStaff = requireMembershipRole(...QUEUE_STAFF);
const servingStaff = requireClinicalRole(...SERVING_STAFF);

const RefusalSchema = z.object({ message: z.string(), code: z.string() });
const IdParamsSchema = z.object({ id: z.uuid() });
const oneLine = (max: number) => z.string().trim().min(1).max(max).regex(/^\P{C}+$/u, "One line");

const ServicePointSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: z.enum(["triage", "consultation"]),
  /** A clinic's consultation fee item, charged once per visit when the patient joins its queue. */
  consultationItemId: z.uuid().nullable(),
  isActive: z.boolean(),
});

export const QueueEntrySchema = z.object({
  id: z.uuid(),
  encounterId: z.uuid(),
  servicePointId: z.uuid(),
  status: z.enum(["waiting", "serving", "done", "left", "cancelled"]),
  joinedAt: z.string(),
  servingAt: z.string().nullable(),
  /** The membership that called the patient in. */
  servedBy: z.uuid().nullable(),
  endedAt: z.string().nullable(),
  /** Set by triage as it finishes with the patient. */
  priority: z.enum(["emergency", "urgent", "routine"]).nullable(),
});

const QueueViewSchema = z.object({
  servicePoint: ServicePointSchema,
  entries: z.array(z.object({
    entryId: z.uuid(),
    encounterId: z.uuid(),
    status: z.enum(["waiting", "serving"]),
    joinedAt: z.string(),
    servingAt: z.string().nullable(),
    servedBy: z.object({ membershipId: z.uuid(), name: z.string() }).nullable(),
    /** From the visit's triage; null if not triaged. Orders the waiting patients. */
    priority: z.enum(["emergency", "urgent", "routine"]).nullable(),
    patient: z.object({
      id: z.uuid(),
      name: z.string(),
      opNumber: z.string().nullable(),
      sex: z.enum(["male", "female", "intersex"]).nullable(),
      ageYears: z.number().int(),
    }),
  })),
});

const CreateBodySchema = z.object({ name: oneLine(80), kind: z.enum(["triage", "consultation"]) });
const UpdateBodySchema = z.object({
  name: oneLine(80).optional(),
  isActive: z.boolean().optional(),
  /** A clinic's fee item (a consultation item), or null for no fee. Applies to patients who join from now on. */
  consultationItemId: z.uuid().nullable().optional(),
}).refine(
  b => b.name !== undefined || b.isActive !== undefined || b.consultationItemId !== undefined,
  "Change the name, whether it is in use, or the consultation fee",
);
const JoinBodySchema = z.object({ servicePointId: z.uuid() });
const FinishBodySchema = z.object({
  /** Where the patient goes next, e.g. from triage to a clinic. Leave out when they go nowhere else. */
  nextServicePointId: z.uuid().optional(),
  /** Triage only: how soon the patient must be seen. Orders the clinic queues for the rest of the visit. */
  priority: z.enum(["emergency", "urgent", "routine"]).optional(),
});
const RemoveBodySchema = z.object({
  /** `left`: the patient went without being seen. `cancelled`: they were sent here in error. */
  outcome: z.enum(["left", "cancelled"]),
});

const refusals = {
  [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible in the queue's current state"),
};

export const listServicePoints = createRoute({
  tags,
  method: "get",
  path: "/service-points",
  summary: "Service points",
  description: "Triage first, then the clinics by name, each with how many patients are waiting there now.",
  request: { headers: facilityHeaders },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({ servicePoints: z.array(ServicePointSchema.extend({ waiting: z.number().int() })) }),
      "Service points",
    ),
    ...tenantResponses,
  },
});

export const createServicePoint = createRoute({
  tags,
  method: "post",
  path: "/service-points",
  summary: "Create a service point",
  description: "A triage desk, or a clinic where patients are seen (General OPD, MCH, a specialist clinic).",
  middleware: [adminOnly] as const,
  request: { headers: facilityHeaders, body: jsonContentRequired(CreateBodySchema, "The service point") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(ServicePointSchema, "Created"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(CreateBodySchema), "Invalid name or kind"),
    ...tenantResponses,
  },
});

export const updateServicePoint = createRoute({
  tags,
  method: "patch",
  path: "/service-points/{id}",
  summary: "Change a service point",
  description: "Rename it, retire it, or set a clinic's consultation fee. A point with patients still in its queue, or a clinic with appointments booked from today on, cannot be retired.",
  middleware: [adminOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(UpdateBodySchema, "The change") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(ServicePointSchema, "Updated"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(UpdateBodySchema), "Nothing to change"),
    ...tenantResponses,
  },
});

export const viewQueue = createRoute({
  tags,
  method: "get",
  path: "/service-points/{id}/queue",
  summary: "Who is waiting here",
  description:
    "The patients being seen, then those waiting, by arrival: each with name, "
    + "OP number, sex and age. Audited, since it names patients and where they are.",
  middleware: [queueStaff] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(QueueViewSchema, "The queue"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Invalid request"),
    ...tenantResponses,
  },
});

export const joinQueue = createRoute({
  tags,
  method: "post",
  path: "/encounters/{id}/queue",
  summary: "Send a patient to a queue",
  description:
    "For an open outpatient visit or emergency attendance whose patient is in "
    + "no queue: back to a clinic with results, or straight to one. Opening a "
    + "visit already joins triage; finishing in one queue can send the patient "
    + "to the next. Joining a clinic with a fee charges it, once per visit.",
  middleware: [queueStaff] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(JoinBodySchema, "Where to") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(QueueEntrySchema, "Waiting"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(JoinBodySchema), "Invalid request"),
    ...tenantResponses,
  },
});

export const serve = createRoute({
  tags,
  method: "post",
  path: "/queue-entries/{id}/serve",
  summary: "Call a patient in",
  description: "The caller becomes the clinician who saw the patient here. A patient someone else has already called in is refused.",
  middleware: [servingStaff] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(QueueEntrySchema, "Being seen"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Invalid request"),
    ...clinicalResponses,
  },
});

export const finish = createRoute({
  tags,
  method: "post",
  path: "/queue-entries/{id}/finish",
  summary: "Finish with a patient",
  description: "Optionally sends them on to the next queue in the same step. Triage also sets how soon they must be seen.",
  middleware: [servingStaff] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(FinishBodySchema, "Where next, if anywhere") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ finished: QueueEntrySchema, next: QueueEntrySchema.nullable() }), "Done"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(FinishBodySchema), "Invalid request"),
    ...clinicalResponses,
  },
});

export const removeFromQueue = createRoute({
  tags,
  method: "post",
  path: "/queue-entries/{id}/remove",
  summary: "Take a waiting patient out of the queue",
  middleware: [queueStaff] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(RemoveBodySchema, "Why") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(QueueEntrySchema, "Taken out"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(RemoveBodySchema), "Invalid request"),
    ...tenantResponses,
  },
});

export type ListServicePointsRoute = typeof listServicePoints;
export type CreateServicePointRoute = typeof createServicePoint;
export type UpdateServicePointRoute = typeof updateServicePoint;
export type ViewQueueRoute = typeof viewQueue;
export type JoinQueueRoute = typeof joinQueue;
export type ServeRoute = typeof serve;
export type FinishRoute = typeof finish;
export type RemoveFromQueueRoute = typeof removeFromQueue;
