import { and, asc, eq } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";

import type { AppRouteHandler } from "@/lib/types";

import db from "@/db";
import { facilities, memberships } from "@/db/schema";

import type { ListMyFacilitiesRoute } from "./me.routes";

/**
 * One of the few reads on the OWNER connection, and why it has to be.
 *
 * The picker runs before any facility is chosen, so there is no tenant to set,
 * and the policies would show the app connection nothing. The query is bound
 * to the signed-in user's own id, so it can return only that user's own
 * memberships and the names of those facilities: nothing about any other
 * person, and nothing a membership would not already show them.
 */
export const listMyFacilities: AppRouteHandler<ListMyFacilitiesRoute> = async (c) => {
  const user = c.var.user!;

  const rows = await db
    .select({
      id: facilities.id,
      name: facilities.name,
      status: facilities.status,
      roles: memberships.roles,
    })
    .from(memberships)
    .innerJoin(facilities, eq(facilities.id, memberships.facilityId))
    .where(and(
      eq(memberships.userId, user.id),
      eq(memberships.isActive, true),
    ))
    .orderBy(asc(facilities.name), asc(facilities.id));

  return c.json({ facilities: rows }, HttpStatusCodes.OK);
};
