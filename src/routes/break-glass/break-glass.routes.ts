import { createRoute, z } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import type { TenantBindings } from "@/lib/types";

import { CLINICAL_ROLES } from "@/lib/professions";
import { recordRefusal } from "@/lib/refusal-audit";
import { ONE_LINE } from "@/lib/validation";
import { requireClinicalRole, requireMembershipRole } from "@/middlewares/auth";
import { clinicalResponses, facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";

/**
 * Break-glass (rule 27, SPEC.md D5): a clinician opens a patient's restricted
 * records outside their normal access, with a reason, for 12 hours. Those who
 * recorded them are alerted in an in-app list, and the facility admin
 * reviews each one.
 */
const tags = ["Break-glass"];

const clinicalGuard = requireClinicalRole(...CLINICAL_ROLES);

/**
 * The clinical guard, with each refusal (no clinical role, or a lapsed
 * licence) recorded against the patient in its own transaction (rule 27).
 */
const clinicians = createMiddleware<TenantBindings>(async (c, next) => {
  let passed = false;
  const refused = await clinicalGuard(c, async () => {
    passed = true;
    await next();
  });
  if (!passed) {
    await recordRefusal(c.var.facility.id, {
      actorId: c.var.user!.id,
      action: "patient.break_glass_refused",
      entityType: "patient",
      entityId: z.uuid().safeParse(c.req.param("id")).data ?? null,
      summary: "Refused breaking the glass: no clinical role, or no current licence",
      detail: { membershipId: c.var.membership.id },
    });
  }
  return refused;
});
const alerted = requireMembershipRole("facility_admin", ...CLINICAL_ROLES);
const adminOnly = requireMembershipRole("facility_admin");

const IdParamsSchema = z.object({ id: z.uuid() });
const RefusalSchema = z.object({ message: z.string(), code: z.string() });
const oneLine = (max: number) => z.string().trim().min(3).max(max).regex(ONE_LINE, "One line");

const BreakBodySchema = z.strictObject({
  /** Why, always: an emergency too. Kept with the grant for the review. */
  reason: oneLine(300),
});
const ReviewBodySchema = z.strictObject({ note: oneLine(300).optional() });
const ListQuerySchema = z.object({
  /** Only those not yet reviewed. */
  unreviewed: z.enum(["true", "false"]).transform(v => v === "true").optional(),
  offset: z.coerce.number().int().min(0).default(0),
});

const GrantSchema = z.object({
  id: z.uuid(),
  patientId: z.uuid(),
  expiresAt: z.string(),
});

const ListedSchema = z.object({
  id: z.uuid(),
  patient: z.object({ id: z.uuid(), name: z.string(), opNumber: z.string().nullable() }),
  grantedTo: z.object({ membershipId: z.uuid(), name: z.string() }),
  reason: z.string(),
  grantedAt: z.string(),
  expiresAt: z.string(),
  review: z.object({ at: z.string(), by: z.object({ membershipId: z.uuid(), name: z.string() }), note: z.string().nullable() }).nullable(),
});

export const breakGlass = createRoute({
  tags,
  method: "post",
  path: "/patients/{id}/break-glass",
  summary: "Break the glass on a patient's restricted records",
  description:
    "For 12 hours, the patient's restricted records (HIV, mental health, GBV) "
    + "open for you, each read audited as one made through this. Those who "
    + "recorded them are alerted, and the facility admin reviews it.",
  middleware: [clinicians] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(BreakBodySchema, "Why") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(GrantSchema, "Open until `expiresAt`"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(BreakBodySchema), "No reason"),
    ...clinicalResponses,
  },
});

export const listBreakGlass = createRoute({
  tags,
  method: "get",
  path: "/break-glass",
  summary: "Break-glass alerts",
  description:
    "Latest first, 100 at a time. The facility admin sees every one; a "
    + "clinician, those on patients whose restricted records they recorded. "
    + "Audited.",
  middleware: [alerted] as const,
  request: { headers: facilityHeaders, query: ListQuerySchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ breakGlass: z.array(ListedSchema) }), "Break-glass grants"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(ListQuerySchema), "Invalid request"),
    ...tenantResponses,
  },
});

export const reviewBreakGlass = createRoute({
  tags,
  method: "post",
  path: "/break-glass/{id}/review",
  summary: "Review a break-glass",
  description: "The facility admin's review, once, with a note if wanted.",
  middleware: [adminOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(ReviewBodySchema, "The review") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ id: z.uuid(), reviewedAt: z.string(), reviewNote: z.string().nullable() }), "Reviewed"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Already reviewed"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(ReviewBodySchema), "Invalid request"),
    ...tenantResponses,
  },
});

export type BreakGlassRoute = typeof breakGlass;
export type ListBreakGlassRoute = typeof listBreakGlass;
export type ReviewBreakGlassRoute = typeof reviewBreakGlass;
