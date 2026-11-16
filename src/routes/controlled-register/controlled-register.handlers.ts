import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { TenantRouteHandler } from "@/lib/types";

import * as register from "@/lib/controlled-register";

import type { ViewRegisterRoute } from "./controlled-register.routes";

export const viewRegister: TenantRouteHandler<ViewRegisterRoute> = async (c) => {
  const query = c.req.valid("query");
  try {
    const page = await register.viewRegister(c.var.db, c.var.facility.id, query, { userId: c.var.user!.id, membershipId: c.var.membership.id });
    return c.json({ ...page, lines: page.lines.map(l => ({ ...l, at: l.at.toISOString() })) }, HttpStatusCodes.OK);
  }
  catch (err) {
    // The page asked for is the resource: a drug or store that is not there answers as nothing.
    if (err instanceof register.RegisterError)
      return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
    throw err;
  }
};
