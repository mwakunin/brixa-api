import * as HttpStatusCodes from "stoker/http-status-codes";

import type { TenantRouteHandler } from "@/lib/types";

import * as drugs from "@/lib/sensitive-drugs";

import type { ListSensitiveDrugsRoute, SetSensitiveDrugRoute } from "./sensitive-drugs.routes";

export const listSensitiveDrugs: TenantRouteHandler<ListSensitiveDrugsRoute> = async (c) => {
  return c.json({ drugs: await drugs.listSensitiveDrugs(c.var.db) }, HttpStatusCodes.OK);
};

export const setSensitiveDrug: TenantRouteHandler<SetSensitiveDrugRoute> = async (c) => {
  const { drugCode, category } = c.req.valid("json");
  try {
    await drugs.setDrugSensitivity(c.var.db, c.var.facility.id, drugCode, category, { userId: c.var.user!.id, membershipId: c.var.membership.id });
    return c.json({ drugs: await drugs.listSensitiveDrugs(c.var.db) }, HttpStatusCodes.OK);
  }
  catch (err) {
    if (err instanceof drugs.SensitiveDrugError)
      return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
    throw err;
  }
};
