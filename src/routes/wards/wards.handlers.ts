import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { TenantRouteHandler } from "@/lib/types";

import * as wards from "@/lib/wards";

import type { AddBedRoute, CreateWardRoute, ListWardsRoute } from "./wards.routes";

export const listWards: TenantRouteHandler<ListWardsRoute> = async (c) => {
  return c.json({ wards: await wards.listWards(c.var.db) }, HttpStatusCodes.OK);
};

export const createWard: TenantRouteHandler<CreateWardRoute> = async (c) => {
  const { name } = c.req.valid("json");
  try {
    const ward = await wards.createWard(c.var.db, c.var.facility.id, name, { userId: c.var.user!.id, membershipId: c.var.membership.id });
    return c.json({ id: ward.id, name: ward.name, isActive: ward.isActive }, HttpStatusCodes.CREATED);
  }
  catch (err) {
    if (err instanceof wards.WardError)
      return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
    throw err;
  }
};

export const addBed: TenantRouteHandler<AddBedRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { label } = c.req.valid("json");
  try {
    const bed = await wards.addBed(c.var.db, c.var.facility.id, id, label, { userId: c.var.user!.id, membershipId: c.var.membership.id });
    return c.json({ id: bed.id, label: bed.label, isActive: bed.isActive }, HttpStatusCodes.CREATED);
  }
  catch (err) {
    if (err instanceof wards.WardError && err.code === "ward_not_found")
      return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
    if (err instanceof wards.WardError)
      return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
    throw err;
  }
};
