import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { PatientActor } from "@/lib/patients";
import type { PaymentDetail } from "@/lib/payments";
import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import { allocate, AllocationError, reverseAllocation as reverseAllocationOf } from "@/lib/allocations";
import * as payments from "@/lib/payments";

import type {
  AllocatePaymentRoute,
  GetAccountRoute,
  GetPaymentRoute,
  RecordPaymentRoute,
  ReverseAllocationRoute,
  ReversePaymentRoute,
} from "./payments.routes";

function actorOf(c: Context<TenantBindings>): PatientActor {
  return { userId: c.var.user!.id, membershipId: c.var.membership.id };
}

function iso(d: Date | null) {
  return d ? d.toISOString() : null;
}

function paymentJson(p: PaymentDetail) {
  return {
    id: p.id,
    accountId: p.accountId,
    method: p.method,
    amountCents: p.amountCents,
    reference: p.reference,
    cashierShiftId: p.cashierShiftId,
    encounterId: p.encounterId,
    receiptNumber: p.receiptNumber,
    documentId: p.documentId,
    receivedAt: p.receivedAt.toISOString(),
    receivedBy: p.receivedBy,
    reversedAt: iso(p.reversedAt),
    reversalReason: p.reversalReason,
    unallocatedCents: p.unallocatedCents,
    allocations: p.allocations.map(a => ({ ...a, allocatedAt: a.allocatedAt.toISOString(), reversedAt: iso(a.reversedAt) })),
  };
}

const NOT_FOUND = new Set([
  "patient_not_found",
  "encounter_not_found",
  "invoice_not_found",
  "payment_not_found",
  "allocation_not_found",
]);

/** Runs a write on one payment and answers with it, or with the refusal. */
async function answer<S extends 200 | 201>(c: Context<TenantBindings>, status: S, write: () => Promise<string>) {
  try {
    const id = await write();
    return c.json(paymentJson(await payments.paymentDetail(c.var.db, id)), status);
  }
  catch (err) {
    if (!(err instanceof payments.PaymentError) && !(err instanceof AllocationError))
      throw err;
    if (NOT_FOUND.has(err.code))
      return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
    return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
  }
}

export const recordPayment: TenantRouteHandler<RecordPaymentRoute> = async (c) => {
  const body = c.req.valid("json");
  return answer(c, HttpStatusCodes.CREATED, () => payments.recordPayment(c.var.db, c.var.facility.id, body, actorOf(c))) as never;
};

export const getPayment: TenantRouteHandler<GetPaymentRoute> = async (c) => {
  const { id } = c.req.valid("param");
  try {
    return c.json(paymentJson(await payments.viewPayment(c.var.db, c.var.facility.id, id, actorOf(c))), HttpStatusCodes.OK);
  }
  catch (err) {
    if (err instanceof payments.PaymentError && err.code === "payment_not_found")
      return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
    throw err;
  }
};

export const reversePayment: TenantRouteHandler<ReversePaymentRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { reason } = c.req.valid("json");
  return answer(c, HttpStatusCodes.OK, async () => {
    await payments.reversePayment(c.var.db, c.var.facility.id, id, reason, actorOf(c));
    return id;
  }) as never;
};

export const allocatePayment: TenantRouteHandler<AllocatePaymentRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  return answer(c, HttpStatusCodes.CREATED, async () => {
    await allocate(c.var.db, c.var.facility.id, { paymentId: id, ...body }, actorOf(c));
    return id;
  }) as never;
};

export const reverseAllocation: TenantRouteHandler<ReverseAllocationRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { reason } = c.req.valid("json");
  return answer(c, HttpStatusCodes.OK, async () => (await reverseAllocationOf(c.var.db, c.var.facility.id, id, reason, actorOf(c))).paymentId) as never;
};

export const getAccount: TenantRouteHandler<GetAccountRoute> = async (c) => {
  const { id } = c.req.valid("param");
  try {
    const account = await payments.viewAccount(c.var.db, c.var.facility.id, id, actorOf(c));
    return c.json({ ...account, credit: account.credit.map(r => ({ ...r, receivedAt: r.receivedAt.toISOString() })) }, HttpStatusCodes.OK);
  }
  catch (err) {
    if (err instanceof payments.PaymentError && err.code === "patient_not_found")
      return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
    throw err;
  }
};
