import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { PatientActor } from "@/lib/patients";
import type { ShiftSummary } from "@/lib/payments";
import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import * as payments from "@/lib/payments";

import type { CloseShiftRoute, CurrentShiftRoute, GetShiftRoute, ListShiftsRoute, OpenShiftRoute } from "./shifts.routes";

function actorOf(c: Context<TenantBindings>): PatientActor {
  return { userId: c.var.user!.id, membershipId: c.var.membership.id };
}

function shiftJson(shift: ShiftSummary) {
  return {
    id: shift.id,
    cashierId: shift.cashierId,
    openedAt: shift.openedAt.toISOString(),
    openingFloatCents: shift.openingFloatCents,
    closedAt: shift.closedAt?.toISOString() ?? null,
    declaredCashCents: shift.declaredCashCents,
    cashCents: shift.cashCents,
    cardCents: shift.cardCents,
    paymentCount: shift.paymentCount,
    cashRefundsCents: shift.cashRefundsCents,
    cardRefundsCents: shift.cardRefundsCents,
    refundCount: shift.refundCount,
    expectedCashCents: shift.expectedCashCents,
    varianceCents: shift.varianceCents,
  };
}

function refusal(c: Context<TenantBindings>, err: unknown) {
  if (!(err instanceof payments.PaymentError))
    throw err;
  if (err.code === "shift_not_found")
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
  return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
}

const REVIEWER_ROLES = new Set(["finance_manager", "facility_admin", "auditor"]);

export const openShift: TenantRouteHandler<OpenShiftRoute> = async (c) => {
  const { openingFloatCents } = c.req.valid("json");
  try {
    const id = await payments.openShift(c.var.db, c.var.facility.id, openingFloatCents, actorOf(c));
    return c.json(shiftJson(await payments.shiftSummary(c.var.db, id)), HttpStatusCodes.CREATED);
  }
  catch (err) {
    return refusal(c, err) as never;
  }
};

export const currentShift: TenantRouteHandler<CurrentShiftRoute> = async (c) => {
  const shift = await payments.currentShift(c.var.db, c.var.membership.id);
  return c.json({ shift: shift ? shiftJson(await payments.shiftSummary(c.var.db, shift.id)) : null }, HttpStatusCodes.OK);
};

export const listShifts: TenantRouteHandler<ListShiftsRoute> = async (c) => {
  const rows = await payments.listShifts(c.var.db);
  const shifts = [];
  for (const row of rows)
    shifts.push(shiftJson(await payments.shiftSummary(c.var.db, row.id)));
  return c.json({ shifts }, HttpStatusCodes.OK);
};

export const getShift: TenantRouteHandler<GetShiftRoute> = async (c) => {
  const { id } = c.req.valid("param");
  try {
    const shift = await payments.shiftSummary(c.var.db, id);
    // Another cashier's shift is not theirs to see; say so as "not found".
    if (shift.cashierId !== c.var.membership.id && !c.var.membership.roles.some(r => REVIEWER_ROLES.has(r)))
      return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
    return c.json(shiftJson(shift), HttpStatusCodes.OK);
  }
  catch (err) {
    return refusal(c, err) as never;
  }
};

export const closeShift: TenantRouteHandler<CloseShiftRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { declaredCashCents } = c.req.valid("json");
  try {
    return c.json(shiftJson(await payments.closeShift(c.var.db, c.var.facility.id, id, declaredCashCents, actorOf(c))), HttpStatusCodes.OK);
  }
  catch (err) {
    return refusal(c, err) as never;
  }
};
