import type { Context } from "hono";

import { eq } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";

import type { AppDb } from "@/db";
import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import { facilities } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { normalizePhone } from "@/lib/phone";

import type { GetFacilityRoute, UpdateFacilityRoute } from "./facility.routes";

/**
 * The facility's own row. No WHERE clause, on purpose: RLS scopes
 * `facilities` by its own primary key, so the tenant transaction can see
 * exactly one row.
 */
async function facilityRow(tx: AppDb) {
  const [row] = await tx
    .select({
      id: facilities.id,
      name: facilities.name,
      status: facilities.status,
      kmhfrCode: facilities.kmhfrCode,
      kephLevel: facilities.kephLevel,
      county: facilities.county,
      phone: facilities.phone,
      smsSenderId: facilities.smsSenderId,
    })
    .from(facilities);
  return row;
}

function facilityJson(c: Context<TenantBindings>, row: Awaited<ReturnType<typeof facilityRow>>) {
  return { ...row, roles: c.var.membership.roles };
}

export const getFacility: TenantRouteHandler<GetFacilityRoute> = async (c) => {
  return c.json(facilityJson(c, await facilityRow(c.var.db)), HttpStatusCodes.OK);
};

export const updateFacility: TenantRouteHandler<UpdateFacilityRoute> = async (c) => {
  const { phone } = c.req.valid("json");
  const next = phone === null ? null : normalizePhone(phone);
  const current = await facilityRow(c.var.db);
  if (current.phone !== next) {
    await c.var.db.update(facilities).set({ phone: next }).where(eq(facilities.id, c.var.facility.id));
    await recordAudit(c.var.db, {
      facilityId: c.var.facility.id,
      actorId: c.var.user!.id,
      action: "facility.updated",
      entityType: "facility",
      entityId: c.var.facility.id,
      summary: next ? "Set the facility's phone number" : "Cleared the facility's phone number",
      detail: { phone: { from: current.phone, to: next } },
    });
  }
  return c.json(facilityJson(c, await facilityRow(c.var.db)), HttpStatusCodes.OK);
};
