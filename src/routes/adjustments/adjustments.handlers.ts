import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { PatientActor } from "@/lib/patients";
import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import * as adjustments from "@/lib/adjustments";

import type {
  ApproveAdjustmentRoute,
  ListAdjustmentsRoute,
  RejectAdjustmentRoute,
  RequestAdjustmentRoute,
  WithdrawAdjustmentRoute,
} from "./adjustments.routes";

function actorOf(c: Context<TenantBindings>): PatientActor {
  return { userId: c.var.user!.id, membershipId: c.var.membership.id };
}

type Listed = Awaited<ReturnType<typeof adjustments.listAdjustments>>[number];

function adjustmentJson(row: Listed) {
  return { ...row, requestedAt: row.requestedAt.toISOString(), decidedAt: row.decidedAt?.toISOString() ?? null };
}

const NOT_FOUND = new Set(["invoice_not_found", "not_found"]);

/** Runs a write on one adjustment and answers with it, or with the refusal. */
async function answer<S extends 200 | 201>(c: Context<TenantBindings>, status: S, write: () => Promise<string>) {
  try {
    const id = await write();
    const [row] = await adjustments.listAdjustments(c.var.db, { id });
    return c.json(adjustmentJson(row), status);
  }
  catch (err) {
    if (!(err instanceof adjustments.AdjustmentError))
      throw err;
    if (NOT_FOUND.has(err.code))
      return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
    return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
  }
}

export const requestAdjustment: TenantRouteHandler<RequestAdjustmentRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  return answer(c, HttpStatusCodes.CREATED, () =>
    adjustments.requestAdjustment(c.var.db, c.var.facility.id, { invoiceId: id, ...body }, actorOf(c))) as never;
};

export const listAdjustments: TenantRouteHandler<ListAdjustmentsRoute> = async (c) => {
  const { status } = c.req.valid("query");
  const rows = await adjustments.listAdjustments(c.var.db, { status });
  return c.json({ adjustments: rows.map(adjustmentJson) }, HttpStatusCodes.OK);
};

export const approveAdjustment: TenantRouteHandler<ApproveAdjustmentRoute> = async (c) => {
  const { id } = c.req.valid("param");
  return answer(c, HttpStatusCodes.OK, async () => {
    await adjustments.approveAdjustment(c.var.db, c.var.facility.id, id, actorOf(c));
    return id;
  }) as never;
};

export const rejectAdjustment: TenantRouteHandler<RejectAdjustmentRoute> = async (c) => {
  const { id } = c.req.valid("param");
  return answer(c, HttpStatusCodes.OK, async () => {
    await adjustments.rejectAdjustment(c.var.db, c.var.facility.id, id, actorOf(c));
    return id;
  }) as never;
};

export const withdrawAdjustment: TenantRouteHandler<WithdrawAdjustmentRoute> = async (c) => {
  const { id } = c.req.valid("param");
  return answer(c, HttpStatusCodes.OK, async () => {
    await adjustments.withdrawAdjustment(c.var.db, c.var.facility.id, id, actorOf(c));
    return id;
  }) as never;
};
