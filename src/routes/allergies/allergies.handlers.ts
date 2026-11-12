import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import * as allergies from "@/lib/allergies";

import type { ListAllergiesRoute, RecordAllergyRoute, RemoveAllergyRoute } from "./allergies.routes";

function actorOf(c: Context<TenantBindings>) {
  return { userId: c.var.user!.id, membershipId: c.var.membership.id };
}

function refusal(c: Context, err: unknown) {
  if (!(err instanceof allergies.AllergyError))
    return null;
  if (err.code === "patient_not_found" || err.code === "not_found")
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
  // About the field sent, not the record's state.
  if (err.code === "drug_not_found") {
    return c.json({
      success: false as const,
      error: { name: "ValidationError", issues: [{ code: "custom" as const, path: ["drugCode"], message: err.message }] },
    }, HttpStatusCodes.UNPROCESSABLE_ENTITY);
  }
  return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
}

type Listed = Awaited<ReturnType<typeof allergies.listAllergies>>[number];

function allergyJson(a: Listed) {
  return { ...a, recordedAt: a.recordedAt.toISOString(), removedAt: a.removedAt?.toISOString() ?? null };
}

/** The row as the list shows it: the write answers with the same shape, without a second audit entry. */
async function asListed(c: Context<TenantBindings>, patientId: string, allergyId: string) {
  const all = await allergies.allergiesOf(c.var.db, patientId, true);
  return allergyJson(all.find(a => a.id === allergyId)!);
}

export const listAllergies: TenantRouteHandler<ListAllergiesRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { includeEnded } = c.req.valid("query");
  try {
    const rows = await allergies.listAllergies(c.var.db, c.var.facility.id, id, actorOf(c), includeEnded);
    return c.json({ allergies: rows.map(allergyJson) }, HttpStatusCodes.OK);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};

export const recordAllergy: TenantRouteHandler<RecordAllergyRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  try {
    const row = "noKnownAllergies" in body
      ? await allergies.recordNoKnownAllergies(c.var.db, c.var.facility.id, id, actorOf(c))
      : await allergies.recordAllergy(c.var.db, c.var.facility.id, id, body, actorOf(c));
    return c.json(await asListed(c, id, row.id), HttpStatusCodes.CREATED);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};

export const removeAllergy: TenantRouteHandler<RemoveAllergyRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { reason } = c.req.valid("json");
  try {
    const row = await allergies.removeAllergy(c.var.db, c.var.facility.id, id, reason, actorOf(c));
    return c.json(await asListed(c, row.patientId, row.id), HttpStatusCodes.OK);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};
