import { asc } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";

import type { AppRouteHandler } from "@/lib/types";

import db from "@/db";
import { facilities, priceLists } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { isUniqueViolation, pgConstraintName } from "@/lib/db-errors";
import { createInvitation } from "@/lib/invitations";
import { FISCAL_SERIES, registerSeries } from "@/lib/number-series";
import { nudgingAfterCommit } from "@/lib/outbox-nudge";

import type { CreateFacilityRoute, ListFacilitiesRoute } from "./superadmin.routes";

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
