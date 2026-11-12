import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { DRUG_ROUTES } from "@/lib/drug-catalogue";
import { ORDERING_STAFF } from "@/lib/orders";
import { FREQUENCIES } from "@/lib/prescriptions";
import { CLINICAL_ROLES } from "@/lib/professions";
import { requireClinicalRole, requireMembershipRole } from "@/middlewares/auth";
import { facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";
import { OrderSchema } from "@/routes/orders/order-schemas";

/**
 * Prescriptions, and the drug catalogue they are written from. Prescribing
 * is a clinical act under a current licence (doctors, clinical officers and
 * nurses; a controlled drug, doctors and clinical officers only); its
 * printed `RX-` document is issued as it is written. Medicines are charged
 * when dispensed (P4), not here.
 */
const tags = ["Prescriptions"];

const prescribers = requireClinicalRole(...ORDERING_STAFF);
const cancellers = requireMembershipRole(...ORDERING_STAFF);
const clinicalReaders = requireMembershipRole(...CLINICAL_ROLES);

const RefusalSchema = z.object({ message: z.string(), code: z.string() });
const IdParamsSchema = z.object({ id: z.uuid() });
const oneLine = (max: number) => z.string().trim().min(1).max(max).regex(/^\P{C}+$/u, "One line");
const DecimalSchema = z.string().trim().regex(/^\d{1,8}(?:\.\d{1,3})?$/, "A positive number, at most 3 decimals").refine(v => Number(v) > 0, "More than zero");

const DrugSchema = z.object({
  code: z.string(),
  genericName: z.string(),
  strength: z.string(),
  form: z.string(),
  /** What a dose is counted in. */
  doseUnit: z.string(),
  route: z.enum(DRUG_ROUTES),
  /** A controlled drug's schedule (I to IV); null if not controlled. */
  controlledSchedule: z.enum(["I", "II", "III", "IV"]).nullable(),
});

const MedicineBodySchema = z.strictObject({
  drugCode: z.string().trim().toUpperCase().min(1).max(32),
  /** Each dose, in the drug's dose unit. */
  doseAmount: DecimalSchema,
  /** The drug's usual route unless given. */
  route: z.enum(DRUG_ROUTES).optional(),
  frequency: z.enum(FREQUENCIES),
  /** Required at a regular frequency, optional when needed (prn), none for a single dose (stat). */
  durationDays: z.number().int().min(1).max(365).optional(),
  /** In dose units. Worked out from the dose, frequency and days unless given; required when needed (prn). */
  quantity: DecimalSchema.optional(),
  instructions: oneLine(200).optional(),
  /** Why to prescribe it despite a recorded allergy to it: audited. */
  allergyOverride: oneLine(200).optional(),
})
  .refine(m => m.frequency !== "stat" || m.durationDays === undefined, { message: "A single dose has no duration", path: ["durationDays"] })
  .refine(m => m.frequency !== "stat" || m.quantity === undefined, { message: "A single dose supplies the dose itself; give no quantity", path: ["quantity"] })
  .refine(m => ["stat", "prn"].includes(m.frequency) || m.durationDays !== undefined, { message: "For how many days?", path: ["durationDays"] })
  .refine(m => m.frequency !== "prn" || m.quantity !== undefined, { message: "Give the quantity for a drug taken when needed", path: ["quantity"] });

const PrescribeBodySchema = z.object({
  /** What it is for, printed on the prescription. */
  indication: oneLine(200).optional(),
  items: z.array(MedicineBodySchema).min(1).max(15),
});

const CancelBodySchema = z.object({ reason: oneLine(200) });

const SearchQuerySchema = z.object({
  /** Words from the generic name, or a code or its start. */
  q: z.string().trim().min(2).max(100),
});

const AllergyRefusalSchema = RefusalSchema.extend({
  /** For `drug_allergy`: the recorded allergies each drug matches. */
  allergies: z.array(z.object({
    drugCode: z.string(),
    allergen: z.string(),
    reaction: z.string().nullable(),
    severity: z.string().nullable(),
  })).optional(),
});

export const searchDrugs = createRoute({
  tags,
  method: "get",
  path: "/drugs",
  summary: "Find a drug in the catalogue",
  description: "Each word typed matches the start of a word in the generic name, or the text the start of a code. Current drugs only, at most 20.",
  middleware: [clinicalReaders] as const,
  request: { headers: facilityHeaders, query: SearchQuerySchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ drugs: z.array(DrugSchema) }), "By name and strength"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(SearchQuerySchema), "Too short"),
    ...tenantResponses,
  },
});

export const prescribe = createRoute({
  tags,
  method: "post",
  path: "/encounters/{id}/prescriptions",
  summary: "Write a prescription",
  description:
    "On an open encounter; its printed RX- prescription is issued at once. "
    + "Refused for a drug the patient is recorded as allergic to unless "
    + "`allergyOverride` gives a reason (`drug_allergy`, listing the "
    + "allergies), for a child under 12 without a weight taken today "
    + "(`weight_needed`), and for a controlled drug from a nurse.",
  middleware: [prescribers] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(PrescribeBodySchema, "The prescription") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(OrderSchema, "Written; `prescription` names its document"),
    [HttpStatusCodes.CONFLICT]: jsonContent(AllergyRefusalSchema, "Not possible in the encounter's or patient's state"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(PrescribeBodySchema), "Invalid prescription"),
    ...tenantResponses,
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      z.union([RefusalSchema, z.object({ message: z.string() })]),
      "Role not allowed, a lapsed licence (`licence_expired`), or a controlled drug from a nurse (`controlled_prescriber`)",
    ),
  },
});

export const cancelPrescription = createRoute({
  tags,
  method: "post",
  path: "/prescriptions/{id}/cancel",
  summary: "Cancel a prescription",
  description:
    "What is left of it is cancelled and its paper voided: it keeps its "
    + "number, and checking its code shows it withdrawn. To change a "
    + "prescription, cancel it and write a new one. `id` is the order's.",
  middleware: [cancellers] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(CancelBodySchema, "Why") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(OrderSchema, "Cancelled"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Nothing left to cancel"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(CancelBodySchema), "No reason given"),
    ...tenantResponses,
  },
});

export type SearchDrugsRoute = typeof searchDrugs;
export type PrescribeRoute = typeof prescribe;
export type CancelPrescriptionRoute = typeof cancelPrescription;
