import * as HttpStatusCodes from "stoker/http-status-codes";

import type { TenantRouteHandler } from "@/lib/types";

import { facilities } from "@/db/schema";

import type { GetFacilityRoute } from "./facility.routes";

export const getFacility: TenantRouteHandler<GetFacilityRoute> = async (c) => {
  // No WHERE clause, on purpose: RLS scopes `facilities` by its own primary
  // key, so the tenant transaction can see exactly one row.
  const [row] = await c.var.db
    .select({
      id: facilities.id,
      name: facilities.name,
      status: facilities.status,
      kmhfrCode: facilities.kmhfrCode,
      kephLevel: facilities.kephLevel,
      county: facilities.county,
    })
    .from(facilities);

  return c.json({ ...row, roles: c.var.membership.roles }, HttpStatusCodes.OK);
};
