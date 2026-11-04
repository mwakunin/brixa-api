import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";

import { MEMBERSHIP_ROLES } from "@/lib/roles";
import { personNameSchema } from "@/lib/validation";
import { requireMembershipRole } from "@/middlewares/auth";
import { rateLimits } from "@/middlewares/rate-limit";
import { facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";

/**
 * Staff invitations, run by the facility admin. Accounts are invite-only
 * (SPEC.md §2): this is how every member after the first arrives.
 */
const tags = ["Staff"];
const adminOnly = requireMembershipRole("facility_admin");
const sendLimit = rateLimits.invitationsSent();

const RefusalSchema = z.object({ message: z.string(), code: z.string() });

const InvitationSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
  roles: z.array(z.enum(MEMBERSHIP_ROLES)),
  /** Derived: a pending invitation past its expiry is `expired`. */
  state: z.enum(["pending", "expired", "accepted", "revoked"]),
  /**
   * Whether the email went out. `failed` means the outbox gave up: revoke and
   * invite again once the address is fixed. `not_sent` means it was revoked,
   * expired or its facility suspended before the email was due.
   */
  delivery: z.enum(["queued", "sent", "not_sent", "failed"]),
  expiresAt: z.string(),
  createdAt: z.string(),
});

export const createInvitation = createRoute({
  tags,
  method: "post",
  path: "/staff/invitations",
  summary: "Invite a member of staff",
  description:
    "Emails the person a link to set up their account. Someone who already "
    + "has an account (working at another facility) keeps their password; the "
    + "invitation adds a membership here.",
  middleware: [adminOnly, sendLimit] as const,
  request: {
    headers: facilityHeaders,
    body: jsonContentRequired(z.object({
      email: z.email().max(254),
      name: personNameSchema,
      roles: z.array(z.enum(MEMBERSHIP_ROLES)).min(1).max(MEMBERSHIP_ROLES.length).refine(roles => new Set(roles).size === roles.length, "List each role once"),
    }), "Who, and as what"),
  },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(InvitationSchema, "Invited; the email follows"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Already a member, or already invited"),
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(
      z.object({ message: z.string(), retryAfterSeconds: z.number().int().positive() }),
      "Too many invitations sent this hour",
    ),
    ...tenantResponses,
  },
});

export const listInvitations = createRoute({
  tags,
  method: "get",
  path: "/staff/invitations",
  summary: "Invitations sent from this facility",
  middleware: [adminOnly] as const,
  request: { headers: facilityHeaders },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({ invitations: z.array(InvitationSchema) }),
      "Newest first",
    ),
    ...tenantResponses,
  },
});

export const revokeInvitation = createRoute({
  tags,
  method: "post",
  path: "/staff/invitations/{id}/revoke",
  summary: "Revoke a pending invitation",
  middleware: [adminOnly] as const,
  request: {
    headers: facilityHeaders,
    params: z.object({ id: z.uuid() }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ id: z.uuid(), state: z.literal("revoked") }), "Revoked"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not pending"),
    ...tenantResponses,
  },
});

export type CreateInvitationRoute = typeof createInvitation;
export type ListInvitationsRoute = typeof listInvitations;
export type RevokeInvitationRoute = typeof revokeInvitation;
