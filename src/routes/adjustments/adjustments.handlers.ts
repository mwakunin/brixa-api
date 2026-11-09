import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { AppDb } from "@/db";
import type { PatientActor } from "@/lib/patients";
import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import * as adjustments from "@/lib/adjustments";
import { recordAudit } from "@/lib/audit";

import type {
  ApproveAdjustmentRoute,
  ApproveReversalRoute,
  ListAdjustmentsRoute,
  ListReversalsRoute,
  RejectAdjustmentRoute,
  RejectReversalRoute,
  RequestAdjustmentRoute,
  RequestReversalRoute,
  WithdrawAdjustmentRoute,
  WithdrawReversalRoute,
} from "./adjustments.routes";

function actorOf(c: Context<TenantBindings>): PatientActor {
  return { userId: c.var.user!.id, membershipId: c.var.membership.id };
}

type Listed = Awaited<ReturnType<typeof adjustments.listAdjustments>>[number];

function adjustmentJson(row: Listed) {
  return { ...row, requestedAt: row.requestedAt.toISOString(), decidedAt: row.decidedAt?.toISOString() ?? null, reversedAt: row.reversedAt?.toISOString() ?? null };
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
  // Amounts and reasons on patients' bills: a read worth recording (rule 9).
  await recordAudit(c.var.db, {
    facilityId: c.var.facility.id,
    actorId: c.var.user!.id,
    action: "adjustment.listed",
    entityType: "invoice_adjustment",
    summary: `Listed adjustments (${rows.length})`,
    detail: { status: status ?? null, ids: rows.map(r => r.id) },
  });
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

type ListedReversal = Awaited<ReturnType<typeof adjustments.listReversals>>[number];

function reversalJson(row: ListedReversal) {
  return { ...row, requestedAt: row.requestedAt.toISOString(), decidedAt: row.decidedAt?.toISOString() ?? null };
}

const REVERSAL_NOT_FOUND = new Set(["not_found", "reversal_not_found"]);

async function reversalAnswer<S extends 200 | 201>(c: Context<TenantBindings>, status: S, write: () => Promise<string>) {
  try {
    const id = await write();
    const [row] = await adjustments.listReversals(c.var.db, { id });
    return c.json(reversalJson(row), status);
  }
  catch (err) {
    if (!(err instanceof adjustments.AdjustmentError))
      throw err;
    if (REVERSAL_NOT_FOUND.has(err.code))
      return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
    return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
  }
}

export const requestReversal: TenantRouteHandler<RequestReversalRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { reason } = c.req.valid("json");
  return reversalAnswer(c, HttpStatusCodes.CREATED, () =>
    adjustments.requestReversal(c.var.db, c.var.facility.id, id, reason, actorOf(c))) as never;
};

export const listReversals: TenantRouteHandler<ListReversalsRoute> = async (c) => {
  const { status, offset } = c.req.valid("query");
  const rows = await adjustments.listReversals(c.var.db, { status, offset });
  await recordAudit(c.var.db, {
    facilityId: c.var.facility.id,
    actorId: c.var.user!.id,
    action: "adjustment.reversals_listed",
    entityType: "invoice_adjustment",
    summary: `Listed requests to reverse adjustments (${rows.length})`,
    detail: { status: status ?? null, ids: rows.map(r => r.id) },
  });
  return c.json({ reversals: rows.map(reversalJson) }, HttpStatusCodes.OK);
};

/** Approve, reject or withdraw: the same answer, a different act. */
function decided(c: Context<TenantBindings>, id: string, run: (tx: AppDb, facilityId: string, id: string, actor: PatientActor) => Promise<void>) {
  return reversalAnswer(c, HttpStatusCodes.OK, async () => {
    await run(c.var.db, c.var.facility.id, id, actorOf(c));
    return id;
  });
}

export const approveReversal: TenantRouteHandler<ApproveReversalRoute> = async c => decided(c, c.req.valid("param").id, adjustments.approveReversal) as never;
export const rejectReversal: TenantRouteHandler<RejectReversalRoute> = async c => decided(c, c.req.valid("param").id, adjustments.rejectReversal) as never;
export const withdrawReversal: TenantRouteHandler<WithdrawReversalRoute> = async c => decided(c, c.req.valid("param").id, adjustments.withdrawReversal) as never;
