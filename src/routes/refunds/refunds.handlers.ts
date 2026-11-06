import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { PatientActor } from "@/lib/patients";
import type { ListedRefund } from "@/lib/refunds";
import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import { recordAudit } from "@/lib/audit";
import * as refunds from "@/lib/refunds";

import type {
  ApproveRefundRoute,
  ListRefundsRoute,
  PayRefundRoute,
  RejectRefundRoute,
  RequestRefundRoute,
  ReverseRefundRoute,
  WithdrawRefundRoute,
} from "./refunds.routes";

function actorOf(c: Context<TenantBindings>): PatientActor {
  return { userId: c.var.user!.id, membershipId: c.var.membership.id };
}

function iso(d: Date | null) {
  return d ? d.toISOString() : null;
}

function refundJson(row: ListedRefund) {
  return {
    ...row,
    requestedAt: row.requestedAt.toISOString(),
    decidedAt: iso(row.decidedAt),
    paidAt: iso(row.paidAt),
    reversedAt: iso(row.reversedAt),
  };
}

const NOT_FOUND = new Set(["payment_not_found", "not_found"]);

/** Runs a write on one refund and answers with it, or with the refusal. */
async function answer<S extends 200 | 201>(c: Context<TenantBindings>, status: S, write: () => Promise<string>) {
  try {
    const id = await write();
    const [row] = await refunds.listRefunds(c.var.db, { id });
    return c.json(refundJson(row), status);
  }
  catch (err) {
    if (!(err instanceof refunds.RefundError))
      throw err;
    if (NOT_FOUND.has(err.code))
      return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
    return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
  }
}

export const requestRefund: TenantRouteHandler<RequestRefundRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  return answer(c, HttpStatusCodes.CREATED, () =>
    refunds.requestRefund(c.var.db, c.var.facility.id, { paymentId: id, ...body }, actorOf(c))) as never;
};

export const listRefunds: TenantRouteHandler<ListRefundsRoute> = async (c) => {
  const { status, toPay } = c.req.valid("query");
  const rows = await refunds.listRefunds(c.var.db, { status, toPay: toPay === "true" });
  // Amounts and reasons on patients' money: a read worth recording (rule 9).
  await recordAudit(c.var.db, {
    facilityId: c.var.facility.id,
    actorId: c.var.user!.id,
    action: "refund.listed",
    entityType: "refund",
    summary: `Listed refunds (${rows.length})`,
    detail: { status: status ?? null, toPay: toPay === "true", ids: rows.map(r => r.id) },
  });
  return c.json({ refunds: rows.map(refundJson) }, HttpStatusCodes.OK);
};

/** An action on one refund by id, answered with the refund as it now stands. */
function act(run: (c: Context<TenantBindings>, id: string) => Promise<unknown>) {
  return async (c: Context<TenantBindings>, id: string) =>
    answer(c, HttpStatusCodes.OK, async () => {
      await run(c, id);
      return id;
    });
}

const approve = act((c, id) => refunds.approveRefund(c.var.db, c.var.facility.id, id, actorOf(c)));
const reject = act((c, id) => refunds.rejectRefund(c.var.db, c.var.facility.id, id, actorOf(c)));
const withdraw = act((c, id) => refunds.withdrawRefund(c.var.db, c.var.facility.id, id, actorOf(c)));

export const approveRefund: TenantRouteHandler<ApproveRefundRoute> = async c => approve(c, c.req.valid("param").id) as never;
export const rejectRefund: TenantRouteHandler<RejectRefundRoute> = async c => reject(c, c.req.valid("param").id) as never;
export const withdrawRefund: TenantRouteHandler<WithdrawRefundRoute> = async c => withdraw(c, c.req.valid("param").id) as never;

export const payRefund: TenantRouteHandler<PayRefundRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  return act(() => refunds.payRefund(c.var.db, c.var.facility.id, id, body, actorOf(c)))(c, id) as never;
};

export const reverseRefund: TenantRouteHandler<ReverseRefundRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { reason } = c.req.valid("json");
  return act(() => refunds.reverseRefund(c.var.db, c.var.facility.id, id, reason, actorOf(c)))(c, id) as never;
};
