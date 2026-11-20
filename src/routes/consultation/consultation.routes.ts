import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { CLINICAL_ROLES } from "@/lib/professions";
import { restrictedSchema } from "@/lib/validation";
import { requireClinicalRole, requireMembershipRole } from "@/middlewares/auth";
import { AllergySchema } from "@/routes/allergies/allergies.routes";
import { DiagnosisSchema } from "@/routes/diagnoses/diagnoses.routes";
import { clinicalResponses, facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";
import { ResultSchema } from "@/routes/lab/lab.routes";
import { NoteSchema } from "@/routes/notes/notes.routes";
import { ObservationSchema } from "@/routes/observations/observations.routes";
import { OrderSchema } from "@/routes/orders/order-schemas";

/**
 * The consultation (decided 2026-11-20, after the staff walkthrough): the
 * patient in front of the doctor in one read, and today's complaint,
 * recorded at triage.
 */
const tags = ["Consultation"];

/** Who records today's complaint: triage nurses, and the clinicians who see the patient. */
export const COMPLAINT_STAFF = ["doctor", "clinical_officer", "nurse"] as const;

const complaintStaff = requireClinicalRole(...COMPLAINT_STAFF);
const clinicalReaders = requireMembershipRole(...CLINICAL_ROLES);

const RefusalSchema = z.object({ message: z.string(), code: z.string() });
const IdParamsSchema = z.object({ id: z.uuid() });

const ComplaintSchema = z.object({
  text: z.string(),
  recordedAt: z.string(),
  recordedBy: z.object({ membershipId: z.uuid(), name: z.string() }),
});

const ComplaintBodySchema = z.strictObject({
  /** In a few words, as the patient tells it. */
  text: z.string().trim().min(2).max(200).regex(/^\P{C}+$/u, "One line"),
});

const ConsultationSchema = z.object({
  encounter: z.object({
    id: z.uuid(),
    kind: z.enum(["opd", "emergency", "ipd"]),
    status: z.enum(["open", "closed", "cancelled"]),
    startedAt: z.string(),
  }),
  patient: z.object({
    id: z.uuid(),
    opNumber: z.string().nullable(),
    givenName: z.string(),
    middleNames: z.string().nullable(),
    familyName: z.string(),
    sex: z.enum(["male", "female", "intersex"]).nullable(),
    dateOfBirth: z.string(),
    age: z.number().int(),
  }),
  /** Null until recorded, or when withheld (it is then under `restricted`). */
  complaint: ComplaintSchema.nullable(),
  vitals: z.array(ObservationSchema),
  /** Standing allergies, or "no known allergies"; empty when nobody has asked. */
  allergies: z.array(AllergySchema),
  notes: z.array(NoteSchema),
  diagnoses: z.array(DiagnosisSchema),
  orders: z.array(OrderSchema),
  results: z.array(ResultSchema),
  reports: z.array(z.object({ orderId: z.uuid(), documentId: z.uuid(), number: z.string() })),
  restricted: restrictedSchema,
  lastVisit: z.object({
    encounterId: z.uuid(),
    startedAt: z.string(),
    /** Its clinic is sensitive and you may not see it (rule 27): only the date is shown. */
    restricted: z.boolean(),
    clinic: z.string().nullable(),
    diagnoses: z.array(z.string()),
    medicines: z.array(z.string()),
  }).nullable(),
});

export const viewConsultation = createRoute({
  tags,
  method: "get",
  path: "/encounters/{id}/consultation",
  summary: "The patient in front of the doctor",
  description:
    "Who they are; today's vital signs, allergies and complaint; this visit's notes (signed, and your own drafts), "
    + "diagnoses, orders and results; and the last visit in short. Each part is withheld as its own read withholds it "
    + "(rule 27), listed under `restricted` by date only. Audited once. Earlier visits and old results are behind their own reads.",
  middleware: [clinicalReaders] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(ConsultationSchema, "The consultation"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not an encounter id"),
    ...tenantResponses,
  },
});

export const recordComplaint = createRoute({
  tags,
  method: "put",
  path: "/encounters/{id}/complaint",
  summary: "Record today's complaint",
  description: "Why the patient came today, in a few words, while the visit is open. Sending it again corrects it; each change is audited with the old text.",
  middleware: [complaintStaff] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(ComplaintBodySchema, "The complaint") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ complaint: ComplaintSchema }), "Recorded"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "The visit is no longer open"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(ComplaintBodySchema), "Invalid complaint"),
    ...clinicalResponses,
  },
});

export type ViewConsultationRoute = typeof viewConsultation;
export type RecordComplaintRoute = typeof recordComplaint;
