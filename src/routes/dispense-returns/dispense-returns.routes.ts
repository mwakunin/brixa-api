import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { DISPENSERS } from "@/lib/dispensing";
import { SHORTFALL_APPROVERS } from "@/lib/transfers";
import { ONE_LINE } from "@/lib/validation";
import { requireClinicalRole, requireMembershipRole } from "@/middlewares/auth";
import { clinicalResponses, facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";

/**
 * Medicines a patient brings back: taken back by the pharmacy, under a
 * current licence; an unfit one approved by the finance manager or a
 * pharmacist other than whoever took it back.
 */
const tags = ["Dispensing"];
const dispensers = requireClinicalRole(...DISPENSERS);
const approvers = requireMembershipRole(...SHORTFALL_APPROVERS);
const readers = requireMembershipRole(...DISPENSERS, ...SHORTFALL_APPROVERS, "auditor");

const RefusalSchema = z.object({ message: z.string(), code: z.string() });
const IdParamsSchema = z.object({ id: z.uuid() });

const ReturnSchema = z.object({
  id: z.uuid(),
  dispenseLineId: z.uuid(),
  encounterId: z.uuid(),
  /** Outside the pharmacy, a sensitive medicine's is masked as `-`. */
  code: z.string(),
  name: z.string(),
  quantity: z.number(),
  /** Outside the pharmacy, a sensitive medicine's is not shown. */
  reason: z.string(),
  fitForResale: z.boolean(),
  /** A medicine the facility marked sensitive: outside the pharmacy, named as bills name it. */
  sensitive: z.boolean(),
  /** `done` once the patient is credited; an unfit one `pending` a second person. */
  status: z.enum(["done", "pending", "rejected"]),
  receivedAt: z.string(),
  /** The credit note asked for, when the charge was already billed: approved under invoice adjustments. */
  invoiceAdjustmentId: z.uuid().nullable(),
});

const ReturnBodySchema = z.strictObject({
  /** In the line's base unit. */
  quantity: z.number().int().min(1).max(100_000),
  reason: z.string().trim().min(3).max(200).regex(ONE_LINE, "One line"),
  /** False: it cannot be sold again, so it is a write-off a second person approves. */
  fitForResale: z.boolean(),
});

const ListQuerySchema = z.object({
  status: z.enum(["done", "pending", "rejected"]).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const refusals = { [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible as the medicine and its bill are") };
const forbidden = {
  [HttpStatusCodes.FORBIDDEN]: jsonContent(
    z.union([z.object({ message: z.string(), code: z.enum(["licence_expired", "controlled_dispenser"]) }), z.object({ message: z.string() })]),
    "Role not allowed, a lapsed licence, or a controlled drug from anyone but a pharmacist with a pharmacy licence",
  ),
};

export const recordReturn = createRoute({
  tags,
  method: "post",
  path: "/dispense-lines/{id}/returns",
  summary: "Take back what a patient returns",
  description:
    "At most what was handed over, less what has come back. Fit to sell again, it goes back on the shelf into the "
    + "latest-expiring batch it came from, and the patient is credited at once: a replacement charge while unbilled, "
    + "or a credit note asked for once billed. Unfit, it waits for a second person.",
  middleware: [dispensers] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(ReturnBodySchema, "What came back") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(ReturnSchema, "Taken back"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(ReturnBodySchema), "Invalid return"),
    ...clinicalResponses,
    ...forbidden,
  },
});

export const listReturns = createRoute({
  tags,
  method: "get",
  path: "/dispense-returns",
  summary: "Returns",
  description: "Newest first, 50 a page. `?status=pending` is the approvers' list. Audited, as each names a visit.",
  middleware: [readers] as const,
  request: { headers: facilityHeaders, query: ListQuerySchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ returns: z.array(ReturnSchema) }), "Returns"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(ListQuerySchema), "Invalid filter"),
    ...tenantResponses,
  },
});

function decision(path: string, summary: string, description: string) {
  return createRoute({
    tags,
    method: "post",
    path,
    summary,
    description,
    middleware: [approvers] as const,
    request: { headers: facilityHeaders, params: IdParamsSchema },
    responses: {
      [HttpStatusCodes.OK]: jsonContent(ReturnSchema, "Decided"),
      ...refusals,
      [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not a return id"),
      ...tenantResponses,
    },
  });
}

export const approveReturn = decision("/dispense-returns/{id}/approve", "Approve an unfit return", "By someone other than whoever took it back (rule 24). The patient is credited now.");
export const rejectReturn = decision("/dispense-returns/{id}/reject", "Reject an unfit return", "By someone other than whoever took it back. The patient is not credited.");

export type RecordReturnRoute = typeof recordReturn;
export type ListReturnsRoute = typeof listReturns;
export type ApproveReturnRoute = typeof approveReturn;
export type RejectReturnRoute = typeof rejectReturn;
