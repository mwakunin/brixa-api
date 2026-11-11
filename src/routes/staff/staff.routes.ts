import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { PROFESSION_KEYS } from "@/lib/professions";
import { MEMBERSHIP_ROLES } from "@/lib/roles";
import { personNameSchema } from "@/lib/validation";
import { requireMembershipRole } from "@/middlewares/auth";
import { rateLimits } from "@/middlewares/rate-limit";
import { facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";

/**
 * Staff, run by the facility admin. Accounts are invite-only (SPEC.md §2):
 * invitations are how every member after the first arrives. A clinical role
 * needs the person's practising licence (rule 25), recorded when they are
 * invited, and renewed or carried over to new roles here.
 */
const tags = ["Staff"];
const adminOnly = requireMembershipRole("facility_admin");
const sendLimit = rateLimits.invitationsSent();

const RefusalSchema = z.object({ message: z.string(), code: z.string() });

const ProfessionSchema = z.enum(PROFESSION_KEYS);

const RolesSchema = z.array(z.enum(MEMBERSHIP_ROLES))
  .min(1)
  .max(MEMBERSHIP_ROLES.length)
  .refine(roles => new Set(roles).size === roles.length, "List each role once");

const LicenceInputSchema = z.object({
  /**
   * The profession the licence is held in. Worked out from the clinical roles
   * when they all belong to one; needed when they span several.
   */
  profession: ProfessionSchema.optional(),
  /** As the council printed it; stored uppercase without spaces or dots. */
  number: z.string().trim().min(1).max(40),
  /** The last day it is valid. */
  expiresOn: z.iso.date(),
}).openapi("LicenceInput");

const LicenceSchema = z.object({
  profession: ProfessionSchema,
  /** Named by the profession: KMPDC, COC, NCK, KMLTTB or PPB. */
  council: z.string(),
  councilName: z.string(),
  number: z.string(),
  expiresOn: z.string(),
  /** Derived: `expiring` within 30 days of its last day, `expired` after it. */
  state: z.enum(["valid", "expiring", "expired"]),
});

const MemberSchema = z.object({
  /** The membership's id. */
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  roles: z.array(z.enum(MEMBERSHIP_ROLES)),
  /**
   * Null for a member with no clinical role, and for a clinician whose
   * licence is not on record yet (one who joined before licences were kept):
   * they cannot act clinically until the facility admin records it.
   */
  licence: LicenceSchema.nullable(),
});

const InviteBodySchema = z.object({
  email: z.email().max(254),
  name: personNameSchema,
  roles: RolesSchema,
  /** Required exactly when a role is clinical; refused once already lapsed. */
  licence: LicenceInputSchema.optional(),
});

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
  /** The licence the membership will carry; null without a clinical role. */
  licence: z.object({ profession: ProfessionSchema, number: z.string(), expiresOn: z.string() }).nullable(),
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
    + "invitation adds a membership here. A clinical role needs the person's "
    + "practising licence. Roles may span professions (a nurse who also "
    + "dispenses); the licence is the person's own, in one profession.",
  middleware: [adminOnly, sendLimit] as const,
  request: {
    headers: facilityHeaders,
    body: jsonContentRequired(InviteBodySchema, "Who, and as what"),
  },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(InvitationSchema, "Invited; the email follows"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Already a member, or already invited"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(InviteBodySchema),
      "Invalid details, a licence missing or not needed, its profession unclear, or a lapsed licence",
    ),
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
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(z.object({ id: z.uuid() })), "Not an invitation id"),
    ...tenantResponses,
  },
});

export const listMembers = createRoute({
  tags,
  method: "get",
  path: "/staff/members",
  summary: "The facility's staff, with their licences",
  description:
    "Every active member, by name, with their roles and, for a clinical role, "
    + "their practising licence and whether it is valid, expiring within 30 "
    + "days, or expired. A member with an expired licence cannot perform a "
    + "clinical act until it is renewed.",
  middleware: [adminOnly] as const,
  request: { headers: facilityHeaders },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ members: z.array(MemberSchema) }), "By name"),
    ...tenantResponses,
  },
});

export const setLicence = createRoute({
  tags,
  method: "put",
  path: "/staff/members/{id}/licence",
  summary: "Record a member's renewed licence",
  description: "Replaces the licence number and its last valid day. Audited with the old and new values.",
  middleware: [adminOnly] as const,
  request: {
    headers: facilityHeaders,
    params: z.object({ id: z.uuid() }),
    body: jsonContentRequired(LicenceInputSchema, "The licence now held"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(MemberSchema, "Recorded"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "The member holds no clinical role"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(LicenceInputSchema), "Invalid number, or already lapsed"),
    ...tenantResponses,
  },
});

const ChangeRolesBodySchema = z.object({
  roles: RolesSchema,
  /** Needed when gaining a clinical role without a licence on record. */
  licence: LicenceInputSchema.optional(),
});

export const changeRoles = createRoute({
  tags,
  method: "put",
  path: "/staff/members/{id}/roles",
  summary: "Change a member's roles",
  description:
    "Replaces the member's roles. Gaining a clinical role needs a licence "
    + "unless one is on record; losing every clinical role clears it. The "
    + "facility's last admin cannot lose the admin role. Audited with the old "
    + "and new roles.",
  middleware: [adminOnly] as const,
  request: {
    headers: facilityHeaders,
    params: z.object({ id: z.uuid() }),
    body: jsonContentRequired(ChangeRolesBodySchema, "The roles the member now holds"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(MemberSchema, "Changed"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "The last admin would lose the admin role"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(ChangeRolesBodySchema),
      "Invalid roles, a licence missing or not needed, its profession unclear, or a lapsed licence",
    ),
    ...tenantResponses,
  },
});

export type ChangeRolesRoute = typeof changeRoles;
export type CreateInvitationRoute = typeof createInvitation;
export type ListMembersRoute = typeof listMembers;
export type SetLicenceRoute = typeof setLicence;
export type ListInvitationsRoute = typeof listInvitations;
export type RevokeInvitationRoute = typeof revokeInvitation;
