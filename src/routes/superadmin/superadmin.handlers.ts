import { and, asc, eq, gte, like, lt } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import * as HttpStatusCodes from "stoker/http-status-codes";

import type { AppRouteHandler } from "@/lib/types";

import db from "@/db";
import { account, facilities, priceLists, session, signInEvents, twoFactor, user, verification } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { notify } from "@/lib/auth";
import { addDays, startOfBusinessDay } from "@/lib/dates";
import { isUniqueViolation, pgConstraintName } from "@/lib/db-errors";
import { createInvitation } from "@/lib/invitations";
import { ACCESSION_SERIES, CLINICAL_SERIES, FISCAL_SERIES, registerSeries, STOCK_SERIES } from "@/lib/number-series";
import { nudgingAfterCommit } from "@/lib/outbox-nudge";
import { recordSignInEvent, signInEventsCsv } from "@/lib/sign-in-log";

import type { CreateFacilityRoute, ExportSignInEventsRoute, ListFacilitiesRoute, ResetTwoFactorRoute, SetSmsSenderRoute } from "./superadmin.routes";

/**
 * The superadmin plane runs on the OWNER connection, by design: creating a
 * facility is the one write that happens before any tenant exists, and the
 * runtime role holds no INSERT on `facilities` at all. Everything onboarding
 * creates commits together, so a facility never exists without its number
 * series or its first admin's invitation.
 */
export const createFacility: AppRouteHandler<CreateFacilityRoute> = async (c) => {
  const body = c.req.valid("json");
  const superadmin = c.var.user!;

  try {
    // The first admin's invitation email is nudged out once this commits.
    const created = await nudgingAfterCommit(() => db.transaction(async (tx) => {
      const [facility] = await tx
        .insert(facilities)
        .values({
          name: body.name,
          kmhfrCode: body.kmhfrCode.toUpperCase(),
          kephLevel: body.kephLevel,
          county: body.county ?? null,
          status: "active",
        })
        .returning();

      await registerSeries(tx, {
        facilityId: facility.id,
        kind: "outpatient",
        prefix: body.numbering.outpatientPrefix,
        resetPeriod: "never",
        startAt: body.numbering.nextOutpatientNumber,
      });
      await registerSeries(tx, {
        facilityId: facility.id,
        kind: "inpatient",
        prefix: body.numbering.inpatientPrefix,
        resetPeriod: "never",
        startAt: body.numbering.nextInpatientNumber,
      });
      // Each admission's own number, restarting every year: ADM-2026-0001.
      await registerSeries(tx, {
        facilityId: facility.id,
        kind: "admission",
        prefix: "ADM-",
        resetPeriod: "yearly",
      });
      // Fiscal documents, numbered at finalisation (rule 20): INV-2026-000123.
      for (const [kind, prefix] of FISCAL_SERIES)
        await registerSeries(tx, { facilityId: facility.id, kind, prefix, padding: 6, resetPeriod: "yearly" });
      // Clinical documents, numbered as they are issued: RX-2026-000123.
      for (const [kind, prefix] of CLINICAL_SERIES)
        await registerSeries(tx, { facilityId: facility.id, kind, prefix, padding: 6, resetPeriod: "yearly" });
      // The stores' deliveries and transfers, numbered as they are entered: GRN-2026-000123, TRF-2026-000123.
      for (const [kind, prefix] of STOCK_SERIES)
        await registerSeries(tx, { facilityId: facility.id, kind, prefix, padding: 6, resetPeriod: "yearly" });
      // Specimens, numbered as they are taken: L-20261111-017.
      await registerSeries(tx, { facilityId: facility.id, ...ACCESSION_SERIES });
      // The list that prices the patient account; payers' lists come later.
      await tx.insert(priceLists).values({ facilityId: facility.id, name: "Cash", kind: "cash" });

      await recordAudit(tx, {
        facilityId: facility.id,
        actorId: superadmin.id,
        action: "facility.created",
        entityType: "facility",
        entityId: facility.id,
        summary: `Onboarded ${facility.name} (KMHFR ${facility.kmhfrCode})`,
      });

      const invitation = await createInvitation(tx, {
        facilityId: facility.id,
        email: body.admin.email,
        name: body.admin.name,
        roles: ["facility_admin"],
        invitedBy: superadmin.id,
      });

      return { facility, invitationId: invitation.id };
    }));

    const { facility } = created;
    return c.json({
      id: facility.id,
      name: facility.name,
      kmhfrCode: facility.kmhfrCode,
      kephLevel: facility.kephLevel,
      status: facility.status,
      createdAt: facility.createdAt.toISOString(),
      adminInvitationId: created.invitationId,
    }, HttpStatusCodes.CREATED);
  }
  catch (err) {
    if (isUniqueViolation(err) && pgConstraintName(err) === "facilities_kmhfrCode_unique") {
      return c.json(
        { message: "A facility with that KMHFR code already exists" },
        HttpStatusCodes.CONFLICT,
      );
    }
    throw err;
  }
};

export const listFacilities: AppRouteHandler<ListFacilitiesRoute> = async (c) => {
  const rows = await db
    .select({
      id: facilities.id,
      name: facilities.name,
      kmhfrCode: facilities.kmhfrCode,
      kephLevel: facilities.kephLevel,
      status: facilities.status,
      createdAt: facilities.createdAt,
    })
    .from(facilities)
    .orderBy(asc(facilities.name), asc(facilities.id));

  return c.json({
    facilities: rows.map(r => ({ ...r, createdAt: r.createdAt.toISOString() })),
  }, HttpStatusCodes.OK);
};

/** Sets the sender a facility's SMS go out under, audited in its own log. */
export const setSmsSender: AppRouteHandler<SetSmsSenderRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { senderId } = c.req.valid("json");
  const superadmin = c.var.user!;

  const updated = await db.transaction(async (tx) => {
    const [current] = await tx.select({ smsSenderId: facilities.smsSenderId }).from(facilities).where(eq(facilities.id, id)).for("update").limit(1);
    if (!current)
      return null;
    const [facility] = await tx.update(facilities).set({ smsSenderId: senderId }).where(eq(facilities.id, id)).returning();
    await recordAudit(tx, {
      facilityId: id,
      actorId: superadmin.id,
      action: "facility.updated",
      entityType: "facility",
      entityId: id,
      summary: senderId ? `Set the SMS sender to ${senderId}` : "Cleared the SMS sender",
      detail: { smsSenderId: { from: current.smsSenderId, to: senderId } },
    });
    return facility;
  });

  if (!updated)
    return c.json({ message: "Not Found" }, HttpStatusCodes.NOT_FOUND);
  return c.json({ id: updated.id, smsSenderId: updated.smsSenderId }, HttpStatusCodes.OK);
};

/**
 * The sign-in log between two Nairobi dates, as CSV, for the quarterly
 * review. Read on the owner connection, as the rest of this plane is: no
 * other role may read the log. The export is recorded in the log, by whom
 * and for which dates, in the same transaction.
 */
export const exportSignInEvents: AppRouteHandler<ExportSignInEventsRoute> = async (c) => {
  const { from, to } = c.req.valid("query");
  const superadmin = c.var.user!;
  const person = alias(user, "person");
  const actor = alias(user, "actor");

  const events = await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        at: signInEvents.at,
        event: signInEvents.event,
        factor: signInEvents.factor,
        name: person.name,
        email: person.email,
        actorEmail: actor.email,
        note: signInEvents.note,
        ipAddress: signInEvents.ipAddress,
        userAgent: signInEvents.userAgent,
      })
      .from(signInEvents)
      .leftJoin(person, eq(person.id, signInEvents.userId))
      .leftJoin(actor, eq(actor.id, signInEvents.actorId))
      .where(and(gte(signInEvents.at, startOfBusinessDay(from)), lt(signInEvents.at, startOfBusinessDay(addDays(to, 1)))))
      .orderBy(asc(signInEvents.at), asc(signInEvents.id));
    await recordSignInEvent({ event: "log_exported", actorId: superadmin.id, note: `${from} to ${to}` }, tx);
    return rows;
  });

  return c.body(signInEventsCsv(events), HttpStatusCodes.OK, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="sign-in-log-${from}-to-${to}.csv"`,
    "cache-control": "no-store",
  });
};

/**
 * Resets the two-step sign-in of someone who has lost both their phone and
 * their backup codes, once Brixa support has checked who they are. Never a
 * facility admin's act: an account can belong to several facilities.
 *
 * Their authenticator and backup codes go, every session and every sign-in
 * waiting for a code ends, and the reset is logged with support's reason, in
 * one transaction on the owner connection. It also writes the credential's
 * change time, as a new password does, so a code check already under way is
 * refused its session. Signing in next, they are asked
 * to set an authenticator up again. They are told by email, so a reset they
 * did not ask for does not go unnoticed.
 */
export const resetTwoFactor: AppRouteHandler<ResetTwoFactorRoute> = async (c) => {
  const { email, reason } = c.req.valid("json");
  const superadmin = c.var.user!;

  const [person] = await db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(eq(user.email, email.toLowerCase()));
  if (!person)
    return c.json({ message: "No account with that email" }, HttpStatusCodes.NOT_FOUND);
  if (person.id === superadmin.id) {
    return c.json(
      { message: "Your own two-step sign-in is reset by someone else at Brixa support, not by you.", code: "own_account" as const },
      HttpStatusCodes.CONFLICT,
    );
  }

  await db.transaction(async (tx) => {
    await tx.delete(twoFactor).where(eq(twoFactor.userId, person.id));
    await tx.update(user).set({ twoFactorEnabled: false }).where(eq(user.id, person.id));
    await tx.delete(session).where(eq(session.userId, person.id));
    await tx.delete(verification).where(and(eq(verification.value, person.id), like(verification.identifier, "2fa-%")));
    // A fence for a sign-in already under way: like a password change, this time refuses it a session (lib/auth.ts).
    await tx.update(account).set({ updatedAt: new Date() }).where(and(eq(account.userId, person.id), eq(account.providerId, "credential")));
    await recordSignInEvent({ event: "two_factor_reset", userId: person.id, actorId: superadmin.id, note: reason }, tx);
  });

  await notify(
    person,
    "two-step sign-in reset notice",
    "Your Brixa HMIS two-step sign-in was reset",
    "Brixa support reset two-step sign-in for your Brixa HMIS account, and every device that was signed in has been signed out. The next time you sign in, you will set up an authenticator app again.",
    "If you did not ask for this, tell your administrator straight away.",
  );
  return c.json({ userId: person.id }, HttpStatusCodes.OK);
};
