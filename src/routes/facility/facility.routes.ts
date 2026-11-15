import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { badRequestSchema, forbiddenSchema, notFoundSchema, unauthorizedSchema } from "@/lib/constants";
import { normalizePhone } from "@/lib/phone";
import { requireMembershipRole } from "@/middlewares/auth";
import { MyFacilitySchema } from "@/routes/me/me.routes";

const tags = ["Facility"];

/**
 * The header every tenant route takes. Declared on the route so the OpenAPI
 * document says how to address a facility.
 */
export const facilityHeaders = z.object({
  "x-facility-id": z.uuid().openapi({ description: "The facility this request acts in" }),
});

/** The responses `withFacility` itself can produce, shared by tenant routes. */
export const tenantResponses = {
  [HttpStatusCodes.BAD_REQUEST]: jsonContent(badRequestSchema, "No facility named"),
  [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
  [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Facility suspended, or role not allowed"),
  [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "No such facility, or no membership there"),
};

/** As `tenantResponses`, for a route behind `requireClinicalRole`: a lapsed licence answers 403 with a code. */
export const clinicalResponses = {
  ...tenantResponses,
  [HttpStatusCodes.FORBIDDEN]: jsonContent(
    z.union([z.object({ message: z.string(), code: z.literal("licence_expired") }), forbiddenSchema]),
    "Facility suspended, role not allowed, or a lapsed licence (`licence_expired`)",
  ),
};

const FacilitySchema = MyFacilitySchema.extend({
  kmhfrCode: z.string(),
  kephLevel: z.number().int(),
  county: z.string().nullable(),
  /** The number appointment reminders tell patients to call. */
  phone: z.string().nullable(),
  /** The sender its SMS go out under; null for the platform account's default. */
  smsSenderId: z.string().nullable(),
});

const UpdateBodySchema = z.strictObject({
  phone: z.string().trim().max(30).refine(v => normalizePhone(v) !== null, "Not a phone number we recognise").nullable(),
});

export const getFacility = createRoute({
  tags,
  method: "get",
  path: "/facility",
  summary: "The facility I am working in",
  description:
    "The facility named by X-Facility-Id, with the caller's roles there. "
    + "Open to every member: `withFacility` has already refused anyone without "
    + "an active membership.",
  request: { headers: facilityHeaders },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(FacilitySchema, "The facility and my roles there"),
    ...tenantResponses,
  },
});

export const updateFacility = createRoute({
  tags,
  method: "patch",
  path: "/facility",
  summary: "Change the facility's details",
  description: "The phone number appointment reminders tell patients to call. Facility admin only; audited with the old and new.",
  middleware: [requireMembershipRole("facility_admin")] as const,
  request: { headers: facilityHeaders, body: jsonContentRequired(UpdateBodySchema, "The change") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(FacilitySchema, "Changed"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(UpdateBodySchema), "Invalid change"),
    ...tenantResponses,
  },
});

export type GetFacilityRoute = typeof getFacility;
export type UpdateFacilityRoute = typeof updateFacility;
