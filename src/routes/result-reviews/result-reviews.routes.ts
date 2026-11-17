import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { ORDERING_STAFF } from "@/lib/orders";
import { requireClinicalRole } from "@/middlewares/auth";
import { clinicalResponses, facilityHeaders } from "@/routes/facility/facility.routes";

/**
 * Results to review: each clinician's lab results not yet marked reviewed,
 * so none is missed, whether the patient came back for it or went home.
 */
const tags = ["Lab"];
const reviewers = requireClinicalRole(...ORDERING_STAFF);

const RefusalSchema = z.object({ message: z.string(), code: z.string() });
const IdParamsSchema = z.object({ id: z.uuid() });
const ListQuerySchema = z.object({
  /** `mine`: results of the tests you ordered. `all`: every clinician's, so none waits on someone off duty. */
  scope: z.enum(["mine", "all"]).default("mine"),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const ToReviewSchema = z.object({
  resultId: z.uuid(),
  status: z.enum(["released", "verified"]),
  hasCritical: z.boolean(),
  /** Any value outside its range, or a choice marked abnormal. */
  abnormal: z.boolean(),
  /** When the lab released or verified it, whichever came first. */
  resultedAt: z.string(),
  test: z.object({ code: z.string(), name: z.string() }),
  patient: z.object({ id: z.uuid(), name: z.string(), opNumber: z.string().nullable() }),
  encounterId: z.uuid(),
  /** Whether the patient's visit is still open: if not, they have gone home. */
  visitOpen: z.boolean(),
  orderedBy: z.object({ membershipId: z.uuid(), name: z.string() }),
});

const ReviewedSchema = z.object({
  resultId: z.uuid(),
  reviewedBy: z.object({ membershipId: z.uuid(), name: z.string() }),
  reviewedAt: z.string(),
});

export const listToReview = createRoute({
  tags,
  method: "get",
  path: "/results-to-review",
  summary: "Results to review",
  description:
    "Lab results released or verified and not yet marked reviewed: critical first, then abnormal, then "
    + "the longest waiting, 100 at a time (`?offset=` for the next). A result marked reviewed leaves the "
    + "list, by you or another clinician, so the ones after it move up: after marking one, read again from "
    + "`?offset=0`. A walk-in's results, which go to the "
    + "outside requester, are not listed. A sensitive result you may not see is left off and counted in "
    + "`restricted`. Audited, since it names patients.",
  middleware: [reviewers] as const,
  request: { headers: facilityHeaders, query: ListQuerySchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ results: z.array(ToReviewSchema), restricted: z.number().int() }), "Results to review"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(ListQuerySchema), "Invalid scope or offset"),
    ...clinicalResponses,
  },
});

export const markReviewed = createRoute({
  tags,
  method: "post",
  path: "/lab-results/{id}/reviewed",
  summary: "Mark a result reviewed",
  description:
    "Once per result: it leaves every results-to-review list. A corrected result is a new one, to "
    + "review again. Refused for a result not yet released or verified (`not_reviewable`) and for "
    + "one reviewed already (`already_reviewed`).",
  middleware: [reviewers] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(ReviewedSchema, "Reviewed"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not reviewable now"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Invalid id"),
    ...clinicalResponses,
  },
});

export type ListToReviewRoute = typeof listToReview;
export type MarkReviewedRoute = typeof markReviewed;
