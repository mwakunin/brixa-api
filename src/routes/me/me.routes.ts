import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent } from "stoker/openapi/helpers";

import { unauthorizedSchema } from "@/lib/constants";
import { MEMBERSHIP_ROLES } from "@/lib/roles";
import { requireAuth } from "@/middlewares/auth";

const tags = ["Me"];

const MembershipRoleSchema = z.enum(MEMBERSHIP_ROLES);

export const MyFacilitySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: z.enum(["active", "suspended"]),
  roles: z.array(MembershipRoleSchema),
});

export const listMyFacilities = createRoute({
  tags,
  method: "get",
  path: "/me/facilities",
  summary: "Facilities I can work in",
  description:
    "The facility picker. Lists the signed-in user's active memberships, one "
    + "per facility, with the roles held there. A user with one membership goes "
    + "straight in; a user with several picks one and sends its id in the "
    + "X-Facility-Id header on every tenant request. Suspended facilities are "
    + "listed so the user can see why they are locked out.",
  middleware: [requireAuth] as const,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({ facilities: z.array(MyFacilitySchema) }),
      "Active memberships, by facility name",
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
  },
});

export type ListMyFacilitiesRoute = typeof listMyFacilities;
