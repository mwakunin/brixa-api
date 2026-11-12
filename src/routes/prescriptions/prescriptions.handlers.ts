import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { OrderActor } from "@/lib/orders";
import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import { searchDrugs as findDrugs } from "@/lib/drug-catalogue";
import { ordersOf } from "@/lib/orders";
import * as rx from "@/lib/prescriptions";
import { orderJson } from "@/routes/orders/order-schemas";

import type { CancelPrescriptionRoute, PrescribeRoute, SearchDrugsRoute } from "./prescriptions.routes";

function actorOf(c: Context<TenantBindings>): OrderActor {
  return { userId: c.var.user!.id, membershipId: c.var.membership.id, roles: c.var.membership.roles };
}

/** Refusals about one medicine's field: a validation failure on it, not a conflict. */
const ABOUT_A_MEDICINE: Partial<Record<rx.PrescriptionErrorCode, string>> = { drug_not_found: "drugCode", not_injectable: "route", quantity_too_large: "quantity" };

function refusal(c: Context, err: unknown) {
  if (!(err instanceof rx.PrescriptionError))
    return null;
  if (err.code === "encounter_not_found" || err.code === "not_found")
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
  const field = ABOUT_A_MEDICINE[err.code];
  if (field && err.item !== undefined) {
    return c.json({
      success: false as const,
      error: { name: "ValidationError", issues: [{ code: "custom" as const, path: ["items", err.item, field], message: err.message }] },
    }, HttpStatusCodes.UNPROCESSABLE_ENTITY);
  }
  if (err.code === "controlled_prescriber")
    return c.json({ message: err.message, code: err.code }, HttpStatusCodes.FORBIDDEN);
  if (err.code === "drug_allergy")
    return c.json({ message: err.message, code: err.code, allergies: err.allergies }, HttpStatusCodes.CONFLICT);
  return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
}

/** Runs a change, answering with the order as the orders list shows it. */
async function answer(c: Context<TenantBindings>, act: () => Promise<{ id: string; encounterId: string }>, status: 200 | 201 = HttpStatusCodes.OK) {
  try {
    const order = await act();
    const [shown] = await ordersOf(c.var.db, order.encounterId, { orderId: order.id });
    return c.json(orderJson(shown), status);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused;
    throw err;
  }
}

export const searchDrugs: TenantRouteHandler<SearchDrugsRoute> = async (c) => {
  const { q } = c.req.valid("query");
  return c.json({ drugs: await findDrugs(c.var.db, q) }, HttpStatusCodes.OK);
};

export const prescribe: TenantRouteHandler<PrescribeRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  return answer(c, () => rx.prescribe(c.var.db, c.var.facility.id, id, body, actorOf(c)), HttpStatusCodes.CREATED) as never;
};

export const cancelPrescription: TenantRouteHandler<CancelPrescriptionRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { reason } = c.req.valid("json");
  return answer(c, () => rx.cancelPrescription(c.var.db, c.var.facility.id, id, reason, actorOf(c))) as never;
};
