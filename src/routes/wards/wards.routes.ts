import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { requireMembershipRole } from "@/middlewares/auth";
import { facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";

/** Wards and beds: set up by the facility admin, read by everyone who admits or moves a patient. */
const tags = ["Wards"];
const adminOnly = requireMembershipRole("facility_admin");

const RefusalSchema = z.object({ message: z.string(), code: z.string() });

const BedSchema = z.object({ id: z.uuid(), label: z.string(), isActive: z.boolean(), occupied: z.boolean() });
const WardSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  isActive: z.boolean(),
  /** What a night here is charged as; null until the admin sets it. */
  bedDayItemId: z.uuid().nullable(),
  beds: z.array(BedSchema),
});

const WardBodySchema = z.object({ name: z.string().trim().min(1).max(80).regex(/^\P{C}+$/u, "One line") });
const BedBodySchema = z.object({ label: z.string().trim().min(1).max(20).regex(/^[\w ./-]+$/, "Letters, digits, spaces and . / - only") });
const WardParamsSchema = z.object({ id: z.uuid() });

export const listWards = createRoute({
  tags,
  method: "get",
  path: "/wards",
  summary: "Wards and beds",
  description: "Every ward with its beds, and whether each bed is occupied now.",
  request: { headers: facilityHeaders },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ wards: z.array(WardSchema) }), "Wards"),
    ...tenantResponses,
  },
});

export const createWard = createRoute({
  tags,
  method: "post",
  path: "/wards",
  summary: "Create a ward",
  middleware: [adminOnly] as const,
  request: { headers: facilityHeaders, body: jsonContentRequired(WardBodySchema, "The ward") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(WardSchema.omit({ beds: true }), "Created"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "A ward already has that name"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(WardBodySchema), "Invalid name"),
    ...tenantResponses,
  },
});

export const addBed = createRoute({
  tags,
  method: "post",
  path: "/wards/{id}/beds",
  summary: "Add a bed to a ward",
  middleware: [adminOnly] as const,
  request: { headers: facilityHeaders, params: WardParamsSchema, body: jsonContentRequired(BedBodySchema, "The bed") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(BedSchema.omit({ occupied: true }), "Added"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "The ward already has a bed with that label"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(BedBodySchema), "Invalid label"),
    ...tenantResponses,
  },
});

export const setBedDayItem = createRoute({
  tags,
  method: "patch",
  path: "/wards/{id}",
  summary: "Set what a night in the ward is charged as",
  description: "A bed-day item from the catalogue. Its price comes from the price list on each night's date.",
  middleware: [adminOnly] as const,
  request: {
    headers: facilityHeaders,
    params: WardParamsSchema,
    body: jsonContentRequired(z.object({ bedDayItemId: z.uuid() }), "The bed-day item"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(WardSchema.omit({ beds: true }), "Set"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not a bed-day item"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(WardParamsSchema), "Invalid request"),
    ...tenantResponses,
  },
});

export type ListWardsRoute = typeof listWards;
export type SetBedDayItemRoute = typeof setBedDayItem;
export type CreateWardRoute = typeof createWard;
export type AddBedRoute = typeof addBed;
