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
      address: facilities.address,
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

const NAMED = { phone: "phone number", address: "address" } as const;

export const updateFacility: TenantRouteHandler<UpdateFacilityRoute> = async (c) => {
  const body = c.req.valid("json");
  const wanted = {
    ...(body.phone === undefined ? {} : { phone: body.phone === null ? null : normalizePhone(body.phone) }),
    ...(body.address === undefined ? {} : { address: body.address }),
  };
  // Locked, so a change in flight commits first and the audit names what it left.
  const [current] = await c.var.db.select({ phone: facilities.phone, address: facilities.address }).from(facilities).where(eq(facilities.id, c.var.facility.id)).for("update");
  const changed = (Object.keys(wanted) as (keyof typeof wanted)[]).filter(key => current[key] !== wanted[key]);
  if (changed.length > 0) {
    await c.var.db.update(facilities).set(Object.fromEntries(changed.map(key => [key, wanted[key]]))).where(eq(facilities.id, c.var.facility.id));
    await recordAudit(c.var.db, {
      facilityId: c.var.facility.id,
      actorId: c.var.user!.id,
      action: "facility.updated",
      entityType: "facility",
      entityId: c.var.facility.id,
      summary: changed.map(key => `${wanted[key] ? "Set" : "Cleared"} the facility's ${NAMED[key]}`).join("; "),
      detail: Object.fromEntries(changed.map(key => [key, { from: current[key], to: wanted[key] }])),
    });
  }
  return c.json(facilityJson(c, await facilityRow(c.var.db)), HttpStatusCodes.OK);
};
