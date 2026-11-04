import type { Context } from "hono";

import { eq } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { PatientActor } from "@/lib/patients";
import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import { encounters } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import * as chargesLib from "@/lib/charges";

import type { CancelChargeRoute, ListChargesRoute, PostChargeRoute } from "./charges.routes";

function actorOf(c: Context<TenantBindings>): PatientActor {
  return { userId: c.var.user!.id, membershipId: c.var.membership.id };
}

type Listed = Awaited<ReturnType<typeof chargesLib.listCharges>>[number];

function chargeJson(row: Listed) {
  return {
    ...row,
    capturedAt: row.capturedAt.toISOString(),
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
  };
}

const NOT_FOUND = new Set(["encounter_not_found", "item_not_found", "charge_not_found"]);

function refusal(c: Context<TenantBindings>, err: unknown) {
  if (!(err instanceof chargesLib.ChargeError))
    return null;
  if (NOT_FOUND.has(err.code))
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
  return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
}

export const postCharge: TenantRouteHandler<PostChargeRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  try {
    const charge = await chargesLib.postManualCharge(c.var.db, c.var.facility.id, { encounterId: id, ...body }, actorOf(c));
    const listed = (await chargesLib.listCharges(c.var.db, id)).find(row => row.id === charge.id)!;
    return c.json(chargeJson(listed), HttpStatusCodes.CREATED);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};

export const listCharges: TenantRouteHandler<ListChargesRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const [encounter] = await c.var.db.select({ patientId: encounters.patientId }).from(encounters).where(eq(encounters.id, id)).limit(1);
  if (!encounter)
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);

  const rows = await chargesLib.listCharges(c.var.db, id);
  // What was done for a patient is part of their record (rule 9).
  await recordAudit(c.var.db, {
    facilityId: c.var.facility.id,
    actorId: c.var.user!.id,
    action: "encounter.viewed",
    entityType: "encounter",
    entityId: id,
    summary: "Opened an encounter's charges",
    detail: { patientId: encounter.patientId },
  });

  const totalCents = rows.filter(r => !r.cancelledAt).reduce((sum, r) => sum + r.amountCents, 0);
  return c.json({ charges: rows.map(chargeJson), totalCents }, HttpStatusCodes.OK);
};

export const cancelCharge: TenantRouteHandler<CancelChargeRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { reason } = c.req.valid("json");
  try {
    const cancelled = await chargesLib.cancelCharge(c.var.db, c.var.facility.id, id, reason, actorOf(c));
    return c.json({ id: cancelled.id, cancelledAt: cancelled.cancelledAt!.toISOString() }, HttpStatusCodes.OK);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};
