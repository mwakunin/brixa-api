import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent } from "stoker/openapi/helpers";

import { badRequestSchema, forbiddenSchema, notFoundSchema, unauthorizedSchema } from "@/lib/constants";
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
    [HttpStatusCodes.OK]: jsonContent(
      MyFacilitySchema.extend({
        kmhfrCode: z.string(),
        kephLevel: z.number().int(),
        county: z.string().nullable(),
      }),
      "The facility and my roles there",
    ),
    ...tenantResponses,
  },
});

export type GetFacilityRoute = typeof getFacility;
