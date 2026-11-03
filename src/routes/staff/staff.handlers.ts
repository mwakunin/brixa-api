import { desc, eq, ne, sql } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";

import type { outbox } from "@/db/schema";
import type { TenantRouteHandler } from "@/lib/types";

import { invitations } from "@/db/schema";
import * as invites from "@/lib/invitations";
import { invitationRefusal } from "@/routes/invitation-errors";

import type { CreateInvitationRoute, ListInvitationsRoute, RevokeInvitationRoute } from "./staff.routes";

type InvitationRow = typeof invitations.$inferSelect;
type OutboxStatus = (typeof outbox.$inferSelect)["status"];

/** `skipped`: the outbox found nothing to send (revoked, expired, suspended). */
const DELIVERY = { pending: "queued", done: "sent", skipped: "not_sent", failed: "failed" } as const;

/** Expiry is derived, never stored (SCHEMA.md conventions). */
function present(row: InvitationRow, sendStatus: OutboxStatus | null, now = new Date()) {
  const state = row.status === "pending" && row.expiresAt <= now ? "expired" as const : row.status;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    roles: row.roles,
    state,
    delivery: DELIVERY[sendStatus ?? "pending"],
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export const createInvitation: TenantRouteHandler<CreateInvitationRoute> = async (c) => {
  const body = c.req.valid("json");

  try {
    const invitation = await invites.createInvitation(c.var.db, {
      facilityId: c.var.facility.id,
      email: body.email,
      name: body.name,
      roles: body.roles,
      invitedBy: c.var.user!.id,
    });
    return c.json(present(invitation, "pending"), HttpStatusCodes.CREATED);
  }
  catch (err) {
    const refused = invitationRefusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};

/** Closed invitations listed: history, capped. Open ones are never capped. */
const CLOSED_LIMIT = 200;

export const listInvitations: TenantRouteHandler<ListInvitationsRoute> = async (c) => {
  const columns = {
    invitation: invitations,
    // The outer column is named in full: in a one-table query Drizzle renders
    // `invitations.id` as a bare "id", which inside this subquery would mean
    // outbox.id and match nothing.
    sendStatus: sql<OutboxStatus | null>`(
      SELECT o.status FROM outbox o
      WHERE o.subject_id = "invitations"."id" AND o.operation = 'invitation.send'
      ORDER BY o.created_at DESC LIMIT 1
    )`,
  };
  const newestFirst = [desc(invitations.createdAt), desc(invitations.id)];

  /*
   * Every pending invitation, uncapped: its link works until it expires, so
   * an admin must always be able to find it to revoke it. At most one per
   * address (a unique index), so this is bounded by the people invited and
   * not yet arrived. History is capped. RLS scopes both to the facility.
   */
  const [open, closed] = await Promise.all([
    c.var.db.select(columns).from(invitations).where(eq(invitations.status, "pending")).orderBy(...newestFirst),
    c.var.db.select(columns).from(invitations).where(ne(invitations.status, "pending")).orderBy(...newestFirst).limit(CLOSED_LIMIT),
  ]);

  const now = new Date();
  const rows = [...open, ...closed].sort((a, b) =>
    b.invitation.createdAt.getTime() - a.invitation.createdAt.getTime() || b.invitation.id.localeCompare(a.invitation.id));

  return c.json({
    invitations: rows.map(r => present(r.invitation, r.sendStatus, now)),
  }, HttpStatusCodes.OK);
};

export const revokeInvitation: TenantRouteHandler<RevokeInvitationRoute> = async (c) => {
  const { id } = c.req.valid("param");

  try {
    await invites.revokeInvitation(c.var.db, {
      facilityId: c.var.facility.id,
      invitationId: id,
      actorId: c.var.user!.id,
    });
    return c.json({ id, state: "revoked" as const }, HttpStatusCodes.OK);
  }
  catch (err) {
    const refused = invitationRefusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};
