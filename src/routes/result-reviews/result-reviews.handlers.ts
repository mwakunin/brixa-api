import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import * as reviews from "@/lib/result-reviews";

import type { ListToReviewRoute, MarkReviewedRoute } from "./result-reviews.routes";

function actorOf(c: Context<TenantBindings>) {
  return { userId: c.var.user!.id, membershipId: c.var.membership.id };
}

export const listToReview: TenantRouteHandler<ListToReviewRoute> = async (c) => {
  const query = c.req.valid("query");
  const { results, restricted } = await reviews.resultsToReview(c.var.db, c.var.facility.id, query, actorOf(c));
  return c.json({ results: results.map(r => ({ ...r, resultedAt: r.resultedAt.toISOString() })), restricted }, HttpStatusCodes.OK);
};

export const markReviewed: TenantRouteHandler<MarkReviewedRoute> = async (c) => {
  const { id } = c.req.valid("param");
  try {
    const reviewed = await reviews.markReviewed(c.var.db, c.var.facility.id, id, actorOf(c));
    return c.json({ ...reviewed, reviewedAt: reviewed.reviewedAt.toISOString() }, HttpStatusCodes.CREATED);
  }
  catch (err) {
    if (!(err instanceof reviews.ReviewError))
      throw err;
    if (err.code === "not_found")
      return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
    return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
  }
};
