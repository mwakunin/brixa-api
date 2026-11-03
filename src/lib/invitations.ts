import { and, eq, sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";

import type { AppDb } from "@/db";
import type { MembershipRole } from "@/db/schema";

import db from "@/db";
import { facilities, invitations, memberships, user } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import env from "@/env";

import { claimAccount } from "./accounts";
import { recordAudit } from "./audit";
import { sendEmail } from "./email";
import { enqueue } from "./outbox";

/**
 * Invitations: how every staff account comes to exist (SPEC.md §2).
 *
 *   create   in the inviter's transaction: the row, its outbox job, an audit
 *   send     the outbox handler: issue a token, then email the link
 *   accept   from the link: account, membership, audit, in one tenant
 *            transaction for the facility the invitation belongs to
 */

/** How long a link works. A facility admin can invite again after it lapses. */
export const INVITATION_TTL_DAYS = 7;

export type InvitationErrorCode
  = | "already_member"
    | "already_invited"
    | "not_found"
    | "not_pending"
    | "expired"
    | "already_accepted"
    | "password_required"
    | "facility_suspended";

export class InvitationError extends Error {
  constructor(readonly code: InvitationErrorCode) {
    super(`Invitation refused: ${code}`);
    this.name = "InvitationError";
  }
}

/** Only the hash is stored, so a database reader cannot accept an invitation. */
export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Invites `email` to `facilityId` with `roles`.
 *
 * Takes the caller's transaction: the facility admin's tenant transaction, or
 * the superadmin's onboarding transaction. Either way the invitation, the
 * email it needs and the audit entry commit together.
 */
export async function createInvitation(
  tx: AppDb,
  input: {
    facilityId: string;
    email: string;
    name: string;
    roles: MembershipRole[];
    invitedBy: string;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const email = input.email.trim().toLowerCase();

  const [member] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .innerJoin(user, eq(user.id, memberships.userId))
    .where(and(
      eq(memberships.facilityId, input.facilityId),
      eq(memberships.isActive, true),
      eq(user.email, email),
    ))
    .limit(1);
  if (member)
    throw new InvitationError("already_member");

  // One open invitation per address. A lapsed one is closed and replaced, so
  // "invite again" works without a separate revoke.
  const [open] = await tx
    .select({ id: invitations.id, expiresAt: invitations.expiresAt })
    .from(invitations)
    .where(and(
      eq(invitations.facilityId, input.facilityId),
      eq(invitations.email, email),
      eq(invitations.status, "pending"),
    ))
    .for("update")
    .limit(1);

  if (open) {
    if (open.expiresAt > now)
      throw new InvitationError("already_invited");

    await tx.update(invitations).set({ status: "revoked" }).where(eq(invitations.id, open.id));
    await recordAudit(tx, {
      facilityId: input.facilityId,
      actorId: input.invitedBy,
      action: "invitation.revoked",
      entityType: "invitation",
      entityId: open.id,
      summary: `Expired invitation for ${email} replaced by a new one`,
    });
  }

  const [invitation] = await tx
    .insert(invitations)
    .values({
      facilityId: input.facilityId,
      email,
      name: input.name.trim(),
      roles: input.roles,
      invitedBy: input.invitedBy,
      expiresAt: new Date(now.getTime() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000),
    })
    .returning();

  await enqueue(tx, { facilityId: input.facilityId, operation: "invitation.send", subjectId: invitation.id });
  await recordAudit(tx, {
    facilityId: input.facilityId,
    actorId: input.invitedBy,
    action: "invitation.created",
    entityType: "invitation",
    entityId: invitation.id,
    summary: `Invited ${email} as ${input.roles.join(", ")}`,
    detail: { roles: input.roles },
  });

  return invitation;
}

/**
 * The outbox handler for `invitation.send`.
 *
 * Re-reads the invitation rather than trusting the job, so one revoked or
 * accepted in the meantime is skipped. Each run issues a fresh token and
 * replaces the stored hash, then emails after the transaction commits (rule
 * 18). Running twice sends two emails and only the later link works, which is
 * the safe way for at-least-once delivery to go wrong.
 */
export async function sendInvitation(job: { facilityId: string; subjectId: string }): Promise<void> {
  const message = await runAsFacility(job.facilityId, async (tx) => {
    const [row] = await tx
      .select({
        id: invitations.id,
        email: invitations.email,
        name: invitations.name,
        status: invitations.status,
        expiresAt: invitations.expiresAt,
        facilityName: facilities.name,
        facilityStatus: facilities.status,
      })
      .from(invitations)
      .innerJoin(facilities, eq(facilities.id, invitations.facilityId))
      .where(eq(invitations.id, job.subjectId))
      .for("update", { of: invitations })
      .limit(1);

    // A suspended facility sends nothing; its admin can invite again once
    // it is reinstated.
    if (!row || row.status !== "pending" || row.expiresAt <= new Date() || row.facilityStatus !== "active")
      return null;

    const token = randomBytes(32).toString("base64url");
    await tx.update(invitations).set({ tokenHash: hashToken(token) }).where(eq(invitations.id, row.id));

    return { ...row, token };
  });

  if (!message)
    return;

  const link = new URL("/accept-invitation", env.APP_URL);
  link.searchParams.set("token", message.token);

  await sendEmail({
    to: message.email,
    subject: `You're invited to ${message.facilityName}`,
    body: `Hello ${message.name},\n\n`
      + `You have been invited to work at ${message.facilityName}. Open this link to set up your account:\n\n`
      + `${link.toString()}\n\n`
      + `The link works until ${message.expiresAt.toUTCString()}. If you were not expecting this, you can ignore it.`,
  });
}

/**
 * Accepts the invitation a link's token names.
 *
 * The lookup is on the OWNER connection: the request has no session and names
 * no facility, so the token's hash is the whole lookup, and it returns only
 * the facility of the one invitation that hash belongs to. Everything after
 * runs in that facility's tenant transaction, with the invitation locked so a
 * double click cannot grant two memberships.
 */
export async function acceptInvitation(input: { token: string; password?: string; now?: Date }) {
  const now = input.now ?? new Date();
  const tokenHash = hashToken(input.token);

  const [found] = await db
    .select({ id: invitations.id, facilityId: invitations.facilityId })
    .from(invitations)
    .where(eq(invitations.tokenHash, tokenHash))
    .limit(1);
  if (!found)
    throw new InvitationError("not_found");

  return runAsFacility(found.facilityId, async (tx) => {
    const [invitation] = await tx
      .select()
      .from(invitations)
      .where(eq(invitations.id, found.id))
      .for("update")
      .limit(1);

    // A token replaced by a resend while this request waited is as dead as a
    // revoked invitation.
    if (!invitation || invitation.status === "revoked" || invitation.tokenHash !== tokenHash)
      throw new InvitationError("not_found");
    if (invitation.status === "accepted")
      throw new InvitationError("already_accepted");
    if (invitation.expiresAt <= now)
      throw new InvitationError("expired");

    // The token holder already knows the facility exists, so saying why is
    // safe. Nobody joins a suspended facility.
    const [facility] = await tx.select({ id: facilities.id, name: facilities.name, status: facilities.status }).from(facilities);
    if (facility.status !== "active")
      throw new InvitationError("facility_suspended");

    const account = await claimAccount({
      email: invitation.email,
      name: invitation.name,
      password: input.password,
    });
    if (!account)
      throw new InvitationError("password_required");

    // An active membership keeps its roles and gains these; a former one
    // (inactive) comes back with exactly what this invitation offers.
    const [membership] = await tx
      .insert(memberships)
      .values({ facilityId: invitation.facilityId, userId: account.userId, roles: invitation.roles })
      .onConflictDoUpdate({
        target: [memberships.userId, memberships.facilityId],
        set: {
          roles: sql`CASE WHEN ${memberships.isActive}
            THEN ARRAY(SELECT DISTINCT r FROM unnest(${memberships.roles} || excluded.roles) AS r ORDER BY r)
            ELSE excluded.roles END`,
          isActive: true,
          updatedAt: now,
        },
      })
      .returning({ id: memberships.id, roles: memberships.roles });

    await tx
      .update(invitations)
      .set({ status: "accepted", acceptedAt: now, acceptedUserId: account.userId })
      .where(eq(invitations.id, invitation.id));

    await recordAudit(tx, {
      facilityId: invitation.facilityId,
      actorId: account.userId,
      action: "membership.granted",
      entityType: "membership",
      entityId: membership.id,
      summary: `${invitation.email} accepted an invitation as ${invitation.roles.join(", ")}`,
      detail: { invitationId: invitation.id, roles: membership.roles },
    });

    return {
      facilityId: facility.id,
      facilityName: facility.name,
      accountCreated: account.created,
    };
  });
}

/** Closes a pending invitation, so its link stops working. */
export async function revokeInvitation(
  tx: AppDb,
  input: { facilityId: string; invitationId: string; actorId: string },
) {
  const [invitation] = await tx
    .select({ id: invitations.id, email: invitations.email, status: invitations.status })
    .from(invitations)
    .where(and(eq(invitations.facilityId, input.facilityId), eq(invitations.id, input.invitationId)))
    .for("update")
    .limit(1);

  if (!invitation)
    throw new InvitationError("not_found");
  if (invitation.status !== "pending")
    throw new InvitationError("not_pending");

  await tx.update(invitations).set({ status: "revoked" }).where(eq(invitations.id, invitation.id));
  await recordAudit(tx, {
    facilityId: input.facilityId,
    actorId: input.actorId,
    action: "invitation.revoked",
    entityType: "invitation",
    entityId: invitation.id,
    summary: `Revoked the invitation for ${invitation.email}`,
  });
}
