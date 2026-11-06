import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { ListedTransaction } from "@/lib/mpesa";
import type { PatientActor } from "@/lib/patients";
import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import { recordAudit } from "@/lib/audit";
import * as mpesa from "@/lib/mpesa";
import { requestStkPush, stkRequestView } from "@/lib/mpesa-stk";
import { PaymentError } from "@/lib/payments";

import type {
  AssignTransactionRoute,
  GetSettingsRoute,
  GetStkRoute,
  ListTransactionsRoute,
  PutSettingsRoute,
  RejectTransactionRoute,
  RequestStkRoute,
} from "./mpesa.routes";

function actorOf(c: Context<TenantBindings>): PatientActor {
  return { userId: c.var.user!.id, membershipId: c.var.membership.id };
}

function settingsJson(settings: NonNullable<Awaited<ReturnType<typeof mpesa.settingsView>>>) {
  return { ...settings, urlsRegisteredAt: settings.urlsRegisteredAt?.toISOString() ?? null };
}

function transactionJson(row: ListedTransaction) {
  return { ...row, transactedAt: row.transactedAt.toISOString() };
}

const NOT_FOUND = new Set(["not_found", "patient_not_found", "invoice_not_found", "encounter_not_found"]);

function refusal(c: Context<TenantBindings>, err: unknown) {
  if (!(err instanceof mpesa.MpesaError) && !(err instanceof PaymentError))
    throw err;
  if (NOT_FOUND.has(err.code))
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
  return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
}

export const getSettings: TenantRouteHandler<GetSettingsRoute> = async (c) => {
  const settings = await mpesa.settingsView(c.var.db);
  return c.json({ settings: settings ? settingsJson(settings) : null }, HttpStatusCodes.OK);
};

export const putSettings: TenantRouteHandler<PutSettingsRoute> = async (c) => {
  await mpesa.saveSettings(c.var.db, c.var.facility.id, c.req.valid("json"), actorOf(c));
  return c.json({ settings: settingsJson((await mpesa.settingsView(c.var.db))!) }, HttpStatusCodes.OK);
};

export const listTransactions: TenantRouteHandler<ListTransactionsRoute> = async (c) => {
  const { status } = c.req.valid("query");
  const rows = await mpesa.listTransactions(c.var.db, { status });
  // Payers' names, phones and what they typed: a read worth recording (rule 9).
  await recordAudit(c.var.db, {
    facilityId: c.var.facility.id,
    actorId: c.var.user!.id,
    action: "mpesa.listed",
    entityType: "mpesa_transaction",
    summary: `Listed M-Pesa transactions (${rows.length})`,
    detail: { status: status ?? null, ids: rows.map(r => r.id) },
  });
  return c.json({ transactions: rows.map(transactionJson) }, HttpStatusCodes.OK);
};

async function transactionAnswer(c: Context<TenantBindings>, id: string, write: () => Promise<unknown>) {
  try {
    await write();
    const [row] = await mpesa.listTransactions(c.var.db, { id });
    return c.json(transactionJson(row), HttpStatusCodes.OK);
  }
  catch (err) {
    return refusal(c, err);
  }
}

export const assignTransaction: TenantRouteHandler<AssignTransactionRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const target = c.req.valid("json");
  return transactionAnswer(c, id, () => mpesa.assignTransaction(c.var.db, c.var.facility.id, id, target, actorOf(c))) as never;
};

export const rejectTransaction: TenantRouteHandler<RejectTransactionRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { reason } = c.req.valid("json");
  return transactionAnswer(c, id, () => mpesa.rejectTransaction(c.var.db, c.var.facility.id, id, reason, actorOf(c))) as never;
};

type StkView = NonNullable<Awaited<ReturnType<typeof stkRequestView>>>;

function stkJson(request: StkView) {
  return {
    id: request.id,
    patientId: request.patientId,
    invoiceId: request.invoiceId,
    encounterId: request.encounterId,
    phone: request.phone,
    amountCents: request.amountCents,
    status: request.status,
    resultDesc: request.resultDesc,
    receiptNumber: request.receiptNumber,
    paymentId: request.paymentId,
    paymentReversed: request.paymentReversed,
    requestedAt: request.requestedAt.toISOString(),
  };
}

export const requestStk: TenantRouteHandler<RequestStkRoute> = async (c) => {
  try {
    const id = await requestStkPush(c.var.db, c.var.facility.id, c.req.valid("json"), actorOf(c));
    return c.json(stkJson((await stkRequestView(c.var.db, id))!), HttpStatusCodes.ACCEPTED);
  }
  catch (err) {
    return refusal(c, err) as never;
  }
};

export const getStk: TenantRouteHandler<GetStkRoute> = async (c) => {
  const request = await stkRequestView(c.var.db, c.req.valid("param").id);
  if (!request)
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
  return c.json(stkJson(request), HttpStatusCodes.OK);
};
