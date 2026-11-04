import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { businessDate } from "@/lib/dates";
import { IDENTITY_DOCUMENTS, normalizeIdentifier } from "@/lib/patients";
import { normalizePhone } from "@/lib/phone";
import { personNameSchema } from "@/lib/validation";
import { requireMembershipRole } from "@/middlewares/auth";
import { rateLimits } from "@/middlewares/rate-limit";
import { facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";

/**
 * The patient register. Front-desk staff register and correct; every member
 * may search and open a record, because every department has to find the
 * patient in front of it. Each search and each opening is audited.
 */
const tags = ["Patients"];

/** Who may register a patient or correct their details. */
export const REGISTRARS = ["records_clerk", "nurse", "facility_admin"] as const;
const registrarsOnly = requireMembershipRole(...REGISTRARS);

const IDENTIFIER_TYPES = [
  "national_id",
  "passport",
  "birth_certificate",
  "alien_id",
  "refugee_id",
  "sha_number",
  "client_registry_id",
  "other",
] as const;

const SexSchema = z.enum(["male", "female", "intersex"]);
const NoPhoneReasonSchema = z.enum(["no_phone", "unidentified"]);
const NoIdReasonSchema = z.enum(["none_held", "not_carried", "unidentified"]);

const IdentifierSchema = z.object({
  type: z.enum(IDENTIFIER_TYPES),
  value: z.string().trim().min(1).max(60).refine(
    v => /^[A-Z0-9/-]{1,40}$/.test(normalizeIdentifier(v)),
    "Letters, digits, / and - only",
  ),
});

const PhoneSchema = z.string().trim().max(30).refine(v => normalizePhone(v) !== null, "Not a phone number we recognise");

/** A date of birth: a real day, not in the future, not before 1900. */
const DateOfBirthSchema = z.iso.date().refine(d => d >= "1900-01-01" && d <= businessDate(), "Not a possible date of birth");

const RegisterBodySchema = z.object({
  givenName: personNameSchema,
  middleNames: personNameSchema.optional(),
  familyName: personNameSchema,
  /** Null only for an unidentified patient. */
  sex: SexSchema.nullable(),
  /** Either this or `estimatedAgeYears`. */
  dateOfBirth: DateOfBirthSchema.optional(),
  estimatedAgeYears: z.number().int().min(0).max(120).optional(),
  /** Either this or `noPhoneReason`. */
  phone: PhoneSchema.optional(),
  noPhoneReason: NoPhoneReasonSchema.optional(),
  /** An identity document, or `noIdReason`. */
  identifiers: z.array(IdentifierSchema).max(5).default([]),
  noIdReason: NoIdReasonSchema.optional(),
  /** Brought in unable to say who they are. */
  unidentified: z.boolean().default(false),
  /** The clerk saw the likely duplicates and says this is someone else. */
  confirmNotDuplicate: z.boolean().default(false),
}).superRefine((body, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });

  if ((body.dateOfBirth === undefined) === (body.estimatedAgeYears === undefined))
    issue("dateOfBirth", "Give a date of birth or an estimated age, not both");
  if ((body.phone === undefined) === (body.noPhoneReason === undefined))
    issue("phone", "Give a phone number, or the reason there is none");

  const hasDocument = body.identifiers.some(i => (IDENTITY_DOCUMENTS as readonly string[]).includes(i.type));
  if (hasDocument === (body.noIdReason !== undefined))
    issue("identifiers", "Give an identity document, or the reason there is none");

  if (body.sex === null && !body.unidentified)
    issue("sex", "Required unless the patient is unidentified");
  if (!body.unidentified && (body.noPhoneReason === "unidentified" || body.noIdReason === "unidentified"))
    issue("unidentified", "Only an unidentified patient can be missing details for that reason");
});

const UpdateBodySchema = z.object({
  givenName: personNameSchema,
  middleNames: personNameSchema.nullable(),
  familyName: personNameSchema,
  sex: SexSchema.nullable(),
  dateOfBirth: DateOfBirthSchema,
  estimatedAgeYears: z.number().int().min(0).max(120),
  phone: PhoneSchema,
  noPhoneReason: NoPhoneReasonSchema,
  noIdReason: NoIdReasonSchema.nullable(),
  /** Only ever to false: a patient once identified stays identified. */
  unidentified: z.literal(false),
}).partial().refine(body => Object.keys(body).length > 0, "Nothing to change").refine(
  body => body.dateOfBirth === undefined || body.estimatedAgeYears === undefined,
  "Give a date of birth or an estimated age, not both",
).refine(
  body => body.phone === undefined || body.noPhoneReason === undefined,
  "Give a phone number or the reason there is none, not both",
);

const AddIdentifierBodySchema = IdentifierSchema.extend({
  confirmNotDuplicate: z.boolean().default(false),
});

export const PatientSummarySchema = z.object({
  id: z.uuid(),
  opNumber: z.string().nullable(),
  givenName: z.string(),
  middleNames: z.string().nullable(),
  familyName: z.string(),
  sex: SexSchema.nullable(),
  dateOfBirth: z.string(),
  age: z.number().int(),
  phone: z.string().nullable(),
});

const PatientRecordSchema = PatientSummarySchema.omit({ opNumber: true }).extend({
  dobIsEstimated: z.boolean(),
  noPhoneReason: NoPhoneReasonSchema.nullable(),
  noIdReason: NoIdReasonSchema.nullable(),
  unidentified: z.boolean(),
  registeredAt: z.string(),
  numbers: z.array(z.object({ kind: z.enum(["outpatient", "inpatient"]), number: z.string(), issuedAt: z.string() })),
  identifiers: z.array(z.object({ type: z.enum(IDENTIFIER_TYPES), value: z.string(), addedAt: z.string() })),
});

const DuplicateSchema = z.object({
  code: z.literal("possible_duplicate"),
  message: z.string(),
  candidates: z.array(PatientSummarySchema.extend({
    reasons: z.array(z.enum(["same_id", "same_name_and_phone", "same_name_and_birth_date"])),
  })),
});

const PatientParamsSchema = z.object({ id: z.uuid() });
const SearchQuerySchema = z.object({
  q: z.string().trim().min(2).max(100).openapi({ description: "An OP or IP number, phone, ID number, or names" }),
});

const tooManyRequests = jsonContent(
  z.object({ message: z.string(), retryAfterSeconds: z.number().int().positive() }),
  "Too many searches",
);

export const registerPatient = createRoute({
  tags,
  method: "post",
  path: "/patients",
  summary: "Register a patient",
  description:
    "Issues the OP number. If the patient looks like one already on file (same "
    + "ID number, same name and phone, or same names and date of birth), "
    + "answers 409 with the candidates: open the existing record, or send "
    + "again with `confirmNotDuplicate` if this is someone else.",
  middleware: [registrarsOnly] as const,
  request: { headers: facilityHeaders, body: jsonContentRequired(RegisterBodySchema, "The patient") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(PatientRecordSchema, "Registered"),
    [HttpStatusCodes.CONFLICT]: jsonContent(DuplicateSchema, "Possibly already registered"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(RegisterBodySchema), "Missing or invalid details"),
    ...tenantResponses,
  },
});

export const searchPatients = createRoute({
  tags,
  method: "get",
  path: "/patients",
  summary: "Find a patient",
  description: "At most 20 matches, in name order. Each search is audited and rate limited per person.",
  middleware: [rateLimits.patientSearch()] as const,
  request: { headers: facilityHeaders, query: SearchQuerySchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ patients: z.array(PatientSummarySchema) }), "Matches"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(SearchQuerySchema), "Search too short"),
    [HttpStatusCodes.TOO_MANY_REQUESTS]: tooManyRequests,
    ...tenantResponses,
  },
});

export const getPatient = createRoute({
  tags,
  method: "get",
  path: "/patients/{id}",
  summary: "Open a patient's record",
  description: "Every opening is recorded in the audit log.",
  request: { headers: facilityHeaders, params: PatientParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(PatientRecordSchema, "The record"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(PatientParamsSchema), "Not a patient id"),
    ...tenantResponses,
  },
});

export const updatePatient = createRoute({
  tags,
  method: "patch",
  path: "/patients/{id}",
  summary: "Correct a patient's details",
  description: "Each changed field's old and new value is recorded in the audit log.",
  middleware: [registrarsOnly] as const,
  request: {
    headers: facilityHeaders,
    params: PatientParamsSchema,
    body: jsonContentRequired(UpdateBodySchema, "The fields to change"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(PatientRecordSchema, "Corrected"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(UpdateBodySchema), "Invalid change"),
    ...tenantResponses,
  },
});

export const addIdentifier = createRoute({
  tags,
  method: "post",
  path: "/patients/{id}/identifiers",
  summary: "Add an ID number",
  description:
    "Answers 409 with the other patient if someone else already has this "
    + "number; send again with `confirmNotDuplicate` to add it anyway.",
  middleware: [registrarsOnly] as const,
  request: {
    headers: facilityHeaders,
    params: PatientParamsSchema,
    body: jsonContentRequired(AddIdentifierBodySchema, "The identifier"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(PatientRecordSchema, "Added"),
    [HttpStatusCodes.CONFLICT]: jsonContent(DuplicateSchema, "Another patient has this number"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(AddIdentifierBodySchema), "Invalid identifier"),
    ...tenantResponses,
  },
});

export type RegisterPatientRoute = typeof registerPatient;
export type SearchPatientsRoute = typeof searchPatients;
export type GetPatientRoute = typeof getPatient;
export type UpdatePatientRoute = typeof updatePatient;
export type AddIdentifierRoute = typeof addIdentifier;
