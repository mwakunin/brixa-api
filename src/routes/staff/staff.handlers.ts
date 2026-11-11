import type { Context } from "hono";

import { desc, eq, ne, sql } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { outbox } from "@/db/schema";
import type { PractitionerErrorCode } from "@/lib/practitioners";
import type { TenantRouteHandler } from "@/lib/types";

import { invitations } from "@/db/schema";
import * as invites from "@/lib/invitations";
import * as practitioners from "@/lib/practitioners";
import { invitationRefusal } from "@/routes/invitation-errors";

import type { ChangeRolesRoute, CreateInvitationRoute, ListInvitationsRoute, ListMembersRoute, RevokeInvitationRoute, SetLicenceRoute } from "./staff.routes";

type InvitationRow = typeof invitations.$inferSelect;
type OutboxStatus = (typeof outbox.$inferSelect)["status"];

/** `skipped`: the outbox found nothing to send (revoked, expired, suspended). */
const DELIVERY = { pending: "queued", done: "sent", skipped: "not_sent", failed: "failed" } as const;

/** The body field each licence refusal is about, below the licence itself. */
const LICENCE_FIELD: Partial<Record<PractitionerErrorCode, string[]>> = {
  licence_required: [],
  licence_not_needed: [],
  profession_required: ["profession"],
  profession_mismatch: ["profession"],
  licence_expired: ["expiresOn"],
  licence_number_invalid: ["number"],
};

/**
 * A licence or roles refusal, or null for anything else. Those about the
 * body read as a validation failure on its field (`at` is where the licence
 * sits in it); the rest are conflicts with the member's current state.
 */
function practitionerRefusal(c: Context, err: unknown, at: string[]) {
  if (!(err instanceof practitioners.PractitionerError))
    return null;
  if (err.code === "not_found")
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);

  const field = LICENCE_FIELD[err.code];
  if (!field)
    return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);

  const path = [...at, ...field];
  return c.json({
    success: false as const,
    error: { name: "ValidationError", issues: [{ code: "custom" as const, path, message: err.message }] },
  }, HttpStatusCodes.UNPROCESSABLE_ENTITY);
}

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
    licence: row.licenceProfession && row.licenceNumber && row.licenceExpiresOn
      ? { profession: row.licenceProfession, number: row.licenceNumber, expiresOn: row.licenceExpiresOn }
      : null,
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
      licence: body.licence,
      invitedBy: c.var.user!.id,
    });
    return c.json(present(invitation, "pending"), HttpStatusCodes.CREATED);
  }
  catch (err) {
    const refused = practitionerRefusal(c, err, ["licence"]) ?? invitationRefusal(c, err);
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

export const listMembers: TenantRouteHandler<ListMembersRoute> = async (c) => {
  return c.json({ members: await practitioners.listMembers(c.var.db) }, HttpStatusCodes.OK);
};

export const setLicence: TenantRouteHandler<SetLicenceRoute> = async (c) => {
  const { id } = c.req.valid("param");

  try {
    const member = await practitioners.setLicence(c.var.db, c.var.facility.id, id, c.req.valid("json"), { userId: c.var.user!.id });
    return c.json(member, HttpStatusCodes.OK);
  }
  catch (err) {
    const refused = practitionerRefusal(c, err, []);
    if (refused)
      return refused as never;
    throw err;
  }
};

export const changeRoles: TenantRouteHandler<ChangeRolesRoute> = async (c) => {
  const { id } = c.req.valid("param");

  try {
    const member = await practitioners.changeRoles(c.var.db, c.var.facility.id, id, c.req.valid("json"), { userId: c.var.user!.id });
    return c.json(member, HttpStatusCodes.OK);
  }
  catch (err) {
    const refused = practitionerRefusal(c, err, ["licence"]);
    if (refused)
      return refused as never;
    throw err;
  }
};
