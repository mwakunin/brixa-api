import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";

import type { InvitationErrorCode } from "@/lib/invitations";

import { isUniqueViolation, pgConstraintName } from "@/lib/db-errors";
import { InvitationError } from "@/lib/invitations";

/** What each refusal tells the person, and with which status. */
const REFUSALS: Record<InvitationErrorCode, { status: 403 | 404 | 409 | 410 | 422; message: string }> = {
  facility_suspended: { status: HttpStatusCodes.FORBIDDEN, message: "This facility's account is suspended. Please contact support." },
  already_member: { status: HttpStatusCodes.CONFLICT, message: "That person is already a member of this facility" },
  already_invited: { status: HttpStatusCodes.CONFLICT, message: "That address already has an open invitation" },
  not_found: { status: HttpStatusCodes.NOT_FOUND, message: "This invitation link is not valid" },
  not_pending: { status: HttpStatusCodes.CONFLICT, message: "Only a pending invitation can be revoked" },
  expired: { status: HttpStatusCodes.GONE, message: "This invitation has expired. Ask the facility admin to invite you again." },
  already_accepted: { status: HttpStatusCodes.CONFLICT, message: "This invitation has already been accepted. Sign in instead." },
  password_required: { status: HttpStatusCodes.UNPROCESSABLE_ENTITY, message: "Choose a password to set up your account" },
};

/**
 * The response for an invitation refusal, or null if `err` is something else
 * and should propagate. Two concurrent invitations of one address both pass
 * the check in `createInvitation`; the partial unique index stops the second,
 * and it reads as the same refusal.
 *
 * Handlers return it `as never`: its status is one of several the route
 * declares, which the OpenAPI handler type cannot see through a shared helper.
 */
export function invitationRefusal(c: Context, err: unknown): Response | null {
  let code: InvitationErrorCode | null = null;
  if (err instanceof InvitationError)
    code = err.code;
  else if (isUniqueViolation(err) && pgConstraintName(err) === "invitations_one_pending_per_email")
    code = "already_invited";

  if (!code)
    return null;

  const refusal = REFUSALS[code];
  return c.json({ message: refusal.message, code }, refusal.status);
}
