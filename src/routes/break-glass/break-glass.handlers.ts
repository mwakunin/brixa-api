import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import * as sensitivity from "@/lib/sensitivity";

import type { BreakGlassRoute, ListBreakGlassRoute, ReviewBreakGlassRoute } from "./break-glass.routes";

function actorOf(c: Context<TenantBindings>) {
  return { userId: c.var.user!.id, membershipId: c.var.membership.id, roles: c.var.membership.roles };
}

function refusal(c: Context, err: unknown) {
  if (!(err instanceof sensitivity.SensitivityError))
    return null;
  if (err.code === "already_reviewed")
    return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
  return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
}

export const breakGlass: TenantRouteHandler<BreakGlassRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { reason } = c.req.valid("json");
  try {
    const grant = await sensitivity.breakGlass(c.var.db, c.var.facility.id, id, reason, actorOf(c));
    return c.json({ id: grant.id, patientId: grant.patientId, expiresAt: grant.expiresAt.toISOString() }, HttpStatusCodes.CREATED);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};

export const listBreakGlass: TenantRouteHandler<ListBreakGlassRoute> = async (c) => {
  const filter = c.req.valid("query");
  const listed = await sensitivity.listBreakGlass(c.var.db, c.var.facility.id, actorOf(c), filter);
  return c.json({
    breakGlass: listed.map(g => ({
      ...g,
      grantedAt: g.grantedAt.toISOString(),
      expiresAt: g.expiresAt.toISOString(),
      review: g.review && { ...g.review, at: g.review.at.toISOString() },
    })),
  }, HttpStatusCodes.OK);
};

export const reviewBreakGlass: TenantRouteHandler<ReviewBreakGlassRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { note } = c.req.valid("json");
  try {
    const reviewed = await sensitivity.reviewBreakGlass(c.var.db, c.var.facility.id, id, note ?? null, actorOf(c));
    return c.json({ id: reviewed.id, reviewedAt: reviewed.reviewedAt!.toISOString(), reviewNote: reviewed.reviewNote }, HttpStatusCodes.OK);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};
