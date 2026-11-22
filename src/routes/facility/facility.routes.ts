import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { badRequestSchema, forbiddenSchema, notFoundSchema, unauthorizedSchema } from "@/lib/constants";
import { normalizePhone } from "@/lib/phone";
import { ONE_LINE } from "@/lib/validation";
import { requireMembershipRole } from "@/middlewares/auth";
import { MyFacilitySchema } from "@/routes/me/me.routes";

const tags = ["Facility"];

/**
 * The header every tenant route takes. Declared on the route so the OpenAPI
 * document says how to address a facility.
 */
export const facilityHeaders = z.object({
  "x-facility-id": z.uuid().openapi({ description: "The facility this request acts in" }),
  "idempotency-key": z.string().optional().openapi({
    description:
      "On a write: a key made once per action (8 to 200 letters, digits, or . _ : -) and sent again with any retry. "
      + "A repeat is answered with the first answer (`Idempotent-Replayed: true`) and not done again; a key sent with another request is refused "
      + "(`idempotency_key_reused`). A refused write keeps nothing, so its retry runs afresh. Keys are kept a day.",
  }),
});

/**
 * The responses `withFacility` itself can produce, shared by tenant routes.
 * Their 404 is also the route's own when what its path names is not there, or
 * not the caller's to see: one description serves both.
 */
export const tenantResponses = {
  [HttpStatusCodes.BAD_REQUEST]: jsonContent(badRequestSchema, "No facility named"),
  [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
  [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Facility suspended, or role not allowed"),
  [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "Not found, or not yours: the facility, a membership there, or what the path names"),
};

/**
 * A tenant write's 409 where the route declares none of its own: an
 * Idempotency-Key already used for another request (`middlewares/tenant.ts`).
 */
export const KeyReusedSchema = z.object({ message: z.string(), code: z.literal("idempotency_key_reused") });

export const keyReused = {
  [HttpStatusCodes.CONFLICT]: jsonContent(KeyReusedSchema, "An Idempotency-Key already used for another request (`idempotency_key_reused`)"),
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
  /** One line, printed under the name at the head of every document it issues. */
  address: z.string().nullable(),
  /** The sender its SMS go out under; null for the platform account's default. */
  smsSenderId: z.string().nullable(),
});

const UpdateBodySchema = z.strictObject({
  phone: z.string().trim().max(30).refine(v => normalizePhone(v) !== null, "Not a phone number we recognise").nullable().optional(),
  address: z.string().trim().min(1).max(200).regex(ONE_LINE, "One line").nullable().optional(),
}).refine(b => b.phone !== undefined || b.address !== undefined, "Give the phone, the address, or both");

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
  description:
    "The phone number appointment reminders tell patients to call, and the address printed at the head of every document issued from now on. "
    + "Either or both; null clears one. Facility admin only; audited with the old and new.",
  middleware: [requireMembershipRole("facility_admin")] as const,
  request: { headers: facilityHeaders, body: jsonContentRequired(UpdateBodySchema, "The change") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(FacilitySchema, "Changed"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(UpdateBodySchema), "Invalid change"),
    ...keyReused,
    ...tenantResponses,
  },
});

export type GetFacilityRoute = typeof getFacility;
export type UpdateFacilityRoute = typeof updateFacility;
