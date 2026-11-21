import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema, createMessageObjectSchema } from "stoker/openapi/schemas";

import { forbiddenSchema, unauthorizedSchema } from "@/lib/constants";
import { facilityNameSchema, ONE_LINE, personNameSchema } from "@/lib/validation";
import { requireAuth, requireRole } from "@/middlewares/auth";
import { rateLimits } from "@/middlewares/rate-limit";

/**
 * The superadmin plane: onboarding facilities, across tenants by design
 * (CLAUDE.md §4). Platform staff only, by the global `user.role`.
 */
const tags = ["Superadmin"];
const superadminOnly = [requireAuth, requireRole("superadmin")];

/** Matches the `number_series_prefix_shape` CHECK. */
const prefixSchema = z.string().trim().regex(/^[A-Z0-9/-]{1,12}$/i, "Letters, digits, / or -, at most 12");

export const CreateFacilitySchema = z.object({
  name: facilityNameSchema,
  /** Kenya Master Health Facility List code. */
  kmhfrCode: z.string().trim().regex(/^[0-9A-Z-]{1,20}$/i, "A KMHFR facility code"),
  kephLevel: z.number().int().min(1).max(6),
  county: z.string().trim().min(2).max(100).optional(),
  /**
   * The facility's own prefixes, and where to continue counting from when it
   * moves from a paper register (SCHEMA.md §6).
   */
  numbering: z.object({
    outpatientPrefix: prefixSchema.default("OP"),
    inpatientPrefix: prefixSchema.default("IP"),
    nextOutpatientNumber: z.number().int().min(1).max(100_000_000).default(1),
    nextInpatientNumber: z.number().int().min(1).max(100_000_000).default(1),
  }).default({
    outpatientPrefix: "OP",
    inpatientPrefix: "IP",
    nextOutpatientNumber: 1,
    nextInpatientNumber: 1,
  }),
  /** The first facility admin, who is emailed an invitation. */
  admin: z.object({
    name: personNameSchema,
    email: z.email().max(254),
  }),
});

/** Matches the `facilities_sms_sender_id_shape` CHECK: an alphanumeric sender is at most 11 characters. */
const SmsSenderBodySchema = z.strictObject({
  senderId: z.string().trim().regex(/^[A-Z0-9][A-Z0-9 ]{0,10}$/i, "At most 11 letters, digits or spaces").nullable(),
});

const FacilitySummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kmhfrCode: z.string(),
  kephLevel: z.number().int(),
  status: z.enum(["active", "suspended"]),
  createdAt: z.string(),
});

export const createFacility = createRoute({
  tags,
  method: "post",
  path: "/superadmin/facilities",
  summary: "Onboard a facility",
  description:
    "Creates the facility, registers its outpatient and inpatient number "
    + "series, and invites its first facility admin, in one transaction. The "
    + "invitation email is sent by the outbox once it commits.",
  middleware: superadminOnly,
  request: { body: jsonContentRequired(CreateFacilitySchema, "The facility and its first admin") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(
      FacilitySummarySchema.extend({ adminInvitationId: z.uuid() }),
      "Onboarded",
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not platform staff"),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      createMessageObjectSchema("A facility with that KMHFR code already exists"),
      "Duplicate KMHFR code",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(CreateFacilitySchema), "Invalid request"),
  },
});

export const listFacilities = createRoute({
  tags,
  method: "get",
  path: "/superadmin/facilities",
  summary: "Every facility",
  middleware: superadminOnly,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({ facilities: z.array(FacilitySummarySchema) }),
      "Facilities, by name",
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not platform staff"),
  },
});

export const setSmsSender = createRoute({
  tags,
  method: "put",
  path: "/superadmin/facilities/{id}/sms-sender",
  summary: "Set a facility's SMS sender",
  description:
    "The sender name its reminders go out under, once Africa's Talking has "
    + "registered it on the platform's account; null for the account's default. "
    + "Audited in the facility's log.",
  middleware: superadminOnly,
  request: {
    params: z.object({ id: z.uuid() }),
    body: jsonContentRequired(SmsSenderBodySchema, "The sender"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ id: z.uuid(), smsSenderId: z.string().nullable() }), "Set"),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not platform staff"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(createMessageObjectSchema("Not Found"), "No such facility"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(SmsSenderBodySchema), "Invalid request"),
  },
});

/** The longest export: a year, so four quarters' reviews fit in one. */
export const EXPORT_MAX_DAYS = 366;

export const SignInEventsQuerySchema = z
  .object({
    /** The first and last Nairobi dates the export covers, both included. */
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .refine(q => q.from <= q.to, { message: "The first date comes before the last", path: ["to"] })
  .refine(q => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 < EXPORT_MAX_DAYS, { message: `At most ${EXPORT_MAX_DAYS} days`, path: ["to"] });

export const exportSignInEvents = createRoute({
  tags,
  method: "get",
  path: "/superadmin/sign-in-events",
  summary: "Export the sign-in log",
  description:
    "Every sign-in, failed attempt, lock and change to how someone signs in, "
    + "between two Nairobi dates, as CSV, for the quarterly review "
    + "(regulation 12). The export is recorded in the log before any of it "
    + "is read, is sent a page at a time, and is limited to ten an hour per "
    + "member of Brixa support. A download that ends unfinished was cut off: "
    + "ask for it again.",
  middleware: [...superadminOnly, rateLimits.signInLogExport()],
  request: { query: SignInEventsQuerySchema },
  responses: {
    [HttpStatusCodes.OK]: {
      content: { "text/csv": { schema: z.string() } },
      description: "The log, oldest first",
    },
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not platform staff"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(SignInEventsQuerySchema), "Not a range of dates"),
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(
      z.object({ message: z.string(), retryAfterSeconds: z.number().int().positive() }),
      "Too many exports",
    ),
  },
});

export const TwoFactorResetBodySchema = z.strictObject({
  email: z.email().max(254),
  /** How who they are was checked, in a sentence: kept with the reset. */
  reason: z.string().trim().min(10).max(500).regex(ONE_LINE, "One line, without control characters"),
});

export const resetTwoFactor = createRoute({
  tags,
  method: "post",
  path: "/superadmin/two-factor-resets",
  summary: "Reset someone's two-step sign-in",
  description:
    "For someone who has lost both their phone and their backup codes, once "
    + "Brixa support has checked who they are. Their authenticator and backup "
    + "codes are removed and every session ends; signing in next, they set up "
    + "an authenticator again. Recorded in the sign-in log with the reason, "
    + "and emailed to them. Never one's own. Refused while the person is "
    + "changing their own two-step sign-in, to be tried again.",
  middleware: superadminOnly,
  request: { body: jsonContentRequired(TwoFactorResetBodySchema, "Whose, and how they were checked") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ userId: z.string() }), "Reset"),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not platform staff"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(createMessageObjectSchema("No account with that email"), "No such account"),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      z.object({ message: z.string(), code: z.enum(["own_account", "TWO_FACTOR_CHANGE_UNDER_WAY"]) }),
      "One's own, or a change to it under way",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(TwoFactorResetBodySchema), "Invalid request"),
  },
});

export type CreateFacilityRoute = typeof createFacility;
export type ListFacilitiesRoute = typeof listFacilities;
export type SetSmsSenderRoute = typeof setSmsSender;
export type ExportSignInEventsRoute = typeof exportSignInEvents;
export type ResetTwoFactorRoute = typeof resetTwoFactor;
