import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { requireMembershipRole } from "@/middlewares/auth";
import { facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";

/**
 * The lab's catalogue: its tests, their analytes, and each number's
 * reference ranges and critical limits. Kept by the facility admin and the
 * lab supervisor; read by every member, since it holds no patient data.
 */
const tags = ["Lab catalogue"];
const catalogueKeepers = requireMembershipRole("facility_admin", "lab_supervisor");

const RefusalSchema = z.object({ message: z.string(), code: z.string() });
const IdParamsSchema = z.object({ id: z.uuid() });

const SPECIMEN_TYPES = ["blood", "urine", "stool", "sputum", "swab", "csf", "body_fluid", "other"] as const;
const oneLine = (max: number) => z.string().trim().min(1).max(max).regex(/^\P{C}+$/u, "One line");

const AnalyteCodeSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9._%#-]{0,15}$/, "Letters, digits and . _ % # - only, at most 16");
const LimitSchema = z.number().finite();

/** Ages in days: from (inclusive) and to (exclusive); none for every age after. */
const RangeSchema = z.object({
  sex: z.enum(["any", "male", "female"]).default("any"),
  ageFromDays: z.number().int().min(0).max(54_750).default(0),
  ageToDays: z.number().int().positive().max(54_750).nullable().default(null),
  low: LimitSchema.nullable().default(null),
  high: LimitSchema.nullable().default(null),
})
  .refine(r => r.low !== null || r.high !== null, { message: "A range needs a low, a high or both", path: ["low"] })
  .refine(r => r.low === null || r.high === null || r.low < r.high, { message: "The low must be below the high", path: ["high"] })
  .refine(r => r.ageToDays === null || r.ageToDays > r.ageFromDays, { message: "The age band must end after it starts", path: ["ageToDays"] });

const RangesSchema = z.array(RangeSchema).max(40);

const NumericAnalyteSchema = z.strictObject({
  code: AnalyteCodeSchema,
  name: oneLine(120),
  resultType: z.literal("numeric"),
  unit: oneLine(20).nullable().optional(),
  criticalLow: LimitSchema.nullable().optional(),
  criticalHigh: LimitSchema.nullable().optional(),
  ranges: RangesSchema.default([]),
}).refine(a => a.criticalLow == null || a.criticalHigh == null || a.criticalLow < a.criticalHigh, {
  message: "The critical low must be below the critical high",
  path: ["criticalHigh"],
});

const ChoicesSchema = z.array(oneLine(60)).min(2).max(20).refine(c => new Set(c).size === c.length, "Each answer once");

const ChoiceAnalyteSchema = z.strictObject({
  code: AnalyteCodeSchema,
  name: oneLine(120),
  resultType: z.literal("choice"),
  /** The answers, in the order offered, e.g. Negative, Positive. */
  choices: ChoicesSchema,
  /** Those flagged abnormal. */
  abnormalChoices: z.array(oneLine(60)).max(20).default([]),
}).refine(a => a.abnormalChoices.every(x => a.choices.includes(x)), {
  message: "Each abnormal answer must be one of the answers",
  path: ["abnormalChoices"],
});

const TextAnalyteSchema = z.strictObject({
  code: AnalyteCodeSchema,
  name: oneLine(120),
  resultType: z.literal("text"),
});

// Strict, so a field that does not fit the result type is refused rather than dropped.
const AnalyteBodySchema = z.discriminatedUnion("resultType", [NumericAnalyteSchema, ChoiceAnalyteSchema, TextAnalyteSchema]);

const CreateBodySchema = z.object({
  /** An active `lab` item: the test goes by its code and name, and is charged at its price. */
  billableItemId: z.uuid(),
  specimenType: z.enum(SPECIMEN_TYPES),
  /** In report order. */
  analytes: z.array(AnalyteBodySchema).min(1).max(60),
}).refine(b => new Set(b.analytes.map(a => a.code)).size === b.analytes.length, {
  message: "Each analyte code once",
  path: ["analytes"],
});

const UpdateTestBodySchema = z.strictObject({
  specimenType: z.enum(SPECIMEN_TYPES).optional(),
  /** False retires it from ordering, e.g. while reagents are out. */
  isActive: z.boolean().optional(),
}).refine(b => b.specimenType !== undefined || b.isActive !== undefined, "Nothing to change");

const UpdateAnalyteBodySchema = z.strictObject({
  name: oneLine(120).optional(),
  unit: oneLine(20).nullable().optional(),
  criticalLow: LimitSchema.nullable().optional(),
  criticalHigh: LimitSchema.nullable().optional(),
  choices: ChoicesSchema.optional(),
  abnormalChoices: z.array(oneLine(60)).max(20).optional(),
  isActive: z.boolean().optional(),
}).refine(b => Object.values(b).some(v => v !== undefined), "Nothing to change");

const RangesBodySchema = z.object({ ranges: RangesSchema });

const ShownRangeSchema = z.object({
  sex: z.enum(["any", "male", "female"]),
  ageFromDays: z.number(),
  ageToDays: z.number().nullable(),
  low: z.number().nullable(),
  high: z.number().nullable(),
});

const AnalyteSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  resultType: z.enum(["numeric", "choice", "text"]),
  unit: z.string().nullable(),
  choices: z.array(z.string()).nullable(),
  abnormalChoices: z.array(z.string()).nullable(),
  criticalLow: z.number().nullable(),
  criticalHigh: z.number().nullable(),
  isActive: z.boolean(),
  ranges: z.array(ShownRangeSchema),
});

const LabTestSchema = z.object({
  id: z.uuid(),
  billableItemId: z.uuid(),
  code: z.string(),
  name: z.string(),
  specimenType: z.enum(SPECIMEN_TYPES),
  isActive: z.boolean(),
  analytes: z.array(AnalyteSchema),
});

const refusals = {
  [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible with the catalogue as it is"),
};

export const listLabTests = createRoute({
  tags,
  method: "get",
  path: "/lab-tests",
  summary: "The lab's tests",
  description: "By code, each with its analytes in report order and their current reference ranges.",
  request: { headers: facilityHeaders },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ tests: z.array(LabTestSchema) }), "The catalogue"),
    ...tenantResponses,
  },
});

export const createLabTest = createRoute({
  tags,
  method: "post",
  path: "/lab-tests",
  summary: "Set up a lab test",
  description:
    "On an active `lab` billable item, whose code, name and price it takes. "
    + "Each analyte is a number (with a unit, reference ranges by sex and age "
    + "in days, and critical limits), a choice from a list, or free text.",
  middleware: [catalogueKeepers] as const,
  request: { headers: facilityHeaders, body: jsonContentRequired(CreateBodySchema, "The test") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(LabTestSchema, "Set up"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(CreateBodySchema), "Invalid test"),
    ...tenantResponses,
  },
});

export const updateLabTest = createRoute({
  tags,
  method: "patch",
  path: "/lab-tests/{id}",
  summary: "Change a test's specimen, or retire it",
  middleware: [catalogueKeepers] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(UpdateTestBodySchema, "What changes") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(LabTestSchema, "Updated"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(UpdateTestBodySchema), "Invalid change"),
    ...tenantResponses,
  },
});

export const addAnalyte = createRoute({
  tags,
  method: "post",
  path: "/lab-tests/{id}/analytes",
  summary: "Add an analyte to a test",
  description: "Last in the test's report.",
  middleware: [catalogueKeepers] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(AnalyteBodySchema, "The analyte") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(LabTestSchema, "Added"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(AnalyteBodySchema), "Invalid analyte"),
    ...tenantResponses,
  },
});

export const updateAnalyte = createRoute({
  tags,
  method: "patch",
  path: "/lab-analytes/{id}",
  summary: "Change an analyte, or retire it",
  description: "Its wording, a number's unit and critical limits, a choice's answers. Never its result type.",
  middleware: [catalogueKeepers] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(UpdateAnalyteBodySchema, "What changes") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(LabTestSchema, "Updated"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(UpdateAnalyteBodySchema), "Invalid change"),
    ...tenantResponses,
  },
});

export const setReferenceRanges = createRoute({
  tags,
  method: "put",
  path: "/lab-analytes/{id}/ranges",
  summary: "Replace a number's reference ranges",
  description:
    "The whole set: the current ranges are retired, and a result keeps the "
    + "range it was judged by. No two may cover the same sex and age; `any` "
    + "covers both sexes. An empty list leaves none.",
  middleware: [catalogueKeepers] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(RangesBodySchema, "The ranges") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(LabTestSchema, "Set"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(RangesBodySchema), "Invalid ranges"),
    ...tenantResponses,
  },
});

export type ListLabTestsRoute = typeof listLabTests;
export type CreateLabTestRoute = typeof createLabTest;
export type UpdateLabTestRoute = typeof updateLabTest;
export type AddAnalyteRoute = typeof addAnalyte;
export type UpdateAnalyteRoute = typeof updateAnalyte;
export type SetReferenceRangesRoute = typeof setReferenceRanges;
