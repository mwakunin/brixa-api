import * as HttpStatusCodes from "stoker/http-status-codes";

import type { AppRouteHandler } from "@/lib/types";

import { acceptInvitation as accept } from "@/lib/invitations";
import { invitationRefusal } from "@/routes/invitation-errors";

import type { AcceptInvitationRoute } from "./invitations.routes";

export const acceptInvitation: AppRouteHandler<AcceptInvitationRoute> = async (c) => {
  const body = c.req.valid("json");

  try {
    const accepted = await accept({ token: body.token, password: body.password });
    return c.json(accepted, HttpStatusCodes.OK);
  }
  catch (err) {
    const refused = invitationRefusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};
