import { desc, sql } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";

import type { outbox } from "@/db/schema";
import type { TenantRouteHandler } from "@/lib/types";

import { invitations } from "@/db/schema";
import * as invites from "@/lib/invitations";
import { invitationRefusal } from "@/routes/invitation-errors";

import type { CreateInvitationRoute, ListInvitationsRoute, RevokeInvitationRoute } from "./staff.routes";

type InvitationRow = typeof invitations.$inferSelect;
type OutboxStatus = (typeof outbox.$inferSelect)["status"];

const DELIVERY = { pending: "queued", done: "sent", failed: "failed" } as const;

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

export const listInvitations: TenantRouteHandler<ListInvitationsRoute> = async (c) => {
  // RLS scopes both tables to the facility; a facility sends a handful a
  // month, so the cap is a backstop rather than pagination.
  const rows = await c.var.db
    .select({
      invitation: invitations,
      // The outer column is named in full: in a one-table query Drizzle
      // renders `invitations.id` as a bare "id", which inside this subquery
      // would mean outbox.id and match nothing.
      sendStatus: sql<OutboxStatus | null>`(
        SELECT o.status FROM outbox o
        WHERE o.subject_id = "invitations"."id" AND o.operation = 'invitation.send'
        ORDER BY o.created_at DESC LIMIT 1
      )`,
    })
    .from(invitations)
    .orderBy(desc(invitations.createdAt), desc(invitations.id))
    .limit(200);

  const now = new Date();
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
