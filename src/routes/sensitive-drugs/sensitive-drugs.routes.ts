import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { DRUG_MARKERS } from "@/lib/sensitive-drugs";
import { sensitiveCategorySchema } from "@/lib/validation";
import { requireMembershipRole } from "@/middlewares/auth";
import { facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";

/**
 * Catalogue drugs whose prescriptions disclose a condition here: marked by
 * the facility admin or a pharmacist. A prescription naming one is
 * restricted as a whole, as a sensitive lab test restricts its order.
 */
const tags = ["Sensitive records"];
const markers = requireMembershipRole(...DRUG_MARKERS);

const DrugsSchema = z.object({
  drugs: z.array(z.object({ drugCode: z.string(), genericName: z.string(), strength: z.string(), form: z.string(), category: sensitiveCategorySchema })),
});

const SetBodySchema = z.strictObject({
  drugCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9._/-]{0,31}$/, "A catalogue drug code"),
  /** Null unmarks it. */
  category: sensitiveCategorySchema.nullable(),
});

export const listSensitiveDrugs = createRoute({
  tags,
  method: "get",
  path: "/sensitive-drugs",
  summary: "The drugs marked sensitive here",
  middleware: [markers] as const,
  request: { headers: facilityHeaders },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(DrugsSchema, "By generic name"),
    ...tenantResponses,
  },
});

export const setSensitiveDrug = createRoute({
  tags,
  method: "put",
  path: "/sensitive-drugs",
  summary: "Mark a drug sensitive, or unmark it",
  description: "Its prescriptions, past and future, follow at once. Audited with the old and new category.",
  middleware: [markers] as const,
  request: { headers: facilityHeaders, body: jsonContentRequired(SetBodySchema, "The drug and its category") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(DrugsSchema, "The drugs marked sensitive now"),
    [HttpStatusCodes.CONFLICT]: jsonContent(z.object({ message: z.string(), code: z.string() }), "No such drug"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(SetBodySchema), "Invalid mark"),
    ...tenantResponses,
  },
});

export type ListSensitiveDrugsRoute = typeof listSensitiveDrugs;
export type SetSensitiveDrugRoute = typeof setSensitiveDrug;
