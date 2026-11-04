import type { Context } from "hono";

import { eq } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { InvoiceDetail } from "@/lib/billing";
import type { PatientActor } from "@/lib/patients";
import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import { encounters } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import * as billing from "@/lib/billing";

import type {
  DraftInvoiceRoute,
  FinaliseInvoiceRoute,
  GetInvoiceRoute,
  ListInvoicesRoute,
  VoidInvoiceRoute,
} from "./invoices.routes";

import { FINANCE } from "./invoices.routes";

function actorOf(c: Context<TenantBindings>): PatientActor {
  return { userId: c.var.user!.id, membershipId: c.var.membership.id };
}

function iso(d: Date | null) {
  return d ? d.toISOString() : null;
}

function invoiceJson(detail: InvoiceDetail) {
  return {
    id: detail.id,
    encounterId: detail.encounterId,
    kind: detail.kind,
    status: detail.status,
    number: detail.number,
    accountKind: detail.accountKind,
    payerName: detail.payerName,
    totalCents: detail.totalCents,
    balanceCents: detail.balanceCents,
    createdAt: detail.createdAt.toISOString(),
    finalisedAt: iso(detail.finalisedAt),
    voidedAt: iso(detail.voidedAt),
    voidReason: detail.voidReason,
    lines: detail.lines,
  };
}

const NOT_FOUND = new Set(["encounter_not_found", "invoice_not_found"]);

function refusal(c: Context<TenantBindings>, err: unknown) {
  if (!(err instanceof billing.BillingError))
    return null;
  if (NOT_FOUND.has(err.code))
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
  if (err.code === "void_needs_finance")
    return c.json({ message: HttpStatusPhrases.FORBIDDEN }, HttpStatusCodes.FORBIDDEN);
  return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
}

/** Runs a write, answering a refusal with its status. */
async function answer(c: Context<TenantBindings>, write: () => Promise<string>) {
  try {
    const id = await write();
    return { detail: await billing.invoiceDetail(c.var.db, id) };
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return { refused };
    throw err;
  }
}

export const draftInvoice: TenantRouteHandler<DraftInvoiceRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { kind } = c.req.valid("json");
  const result = await answer(c, () => billing.draftInvoice(c.var.db, c.var.facility.id, { encounterId: id, kind }, actorOf(c)));
  if (result.refused)
    return result.refused as never;
  return c.json(invoiceJson(result.detail), HttpStatusCodes.CREATED);
};

export const finaliseInvoice: TenantRouteHandler<FinaliseInvoiceRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const result = await answer(c, async () => (await billing.finaliseInvoice(c.var.db, c.var.facility.id, id, actorOf(c))).invoice.id);
  if (result.refused)
    return result.refused as never;
  return c.json(invoiceJson(result.detail), HttpStatusCodes.OK);
};

export const voidInvoice: TenantRouteHandler<VoidInvoiceRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { reason } = c.req.valid("json");
  const mayVoidFinalised = c.var.membership.roles.some(role => (FINANCE as readonly string[]).includes(role));
  const result = await answer(c, async () =>
    (await billing.voidInvoice(c.var.db, c.var.facility.id, { invoiceId: id, reason, mayVoidFinalised }, actorOf(c))).id);
  if (result.refused)
    return result.refused as never;
  return c.json(invoiceJson(result.detail), HttpStatusCodes.OK);
};

export const getInvoice: TenantRouteHandler<GetInvoiceRoute> = async (c) => {
  const { id } = c.req.valid("param");
  try {
    const detail = await billing.viewInvoice(c.var.db, c.var.facility.id, id, actorOf(c));
    return c.json(invoiceJson(detail), HttpStatusCodes.OK);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};

export const listInvoices: TenantRouteHandler<ListInvoicesRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const [encounter] = await c.var.db.select({ patientId: encounters.patientId }).from(encounters).where(eq(encounters.id, id)).limit(1);
  if (!encounter)
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);

  const rows = await billing.listInvoices(c.var.db, id);
  // Who was billed for a patient's care is part of their record (rule 9).
  await recordAudit(c.var.db, {
    facilityId: c.var.facility.id,
    actorId: c.var.user!.id,
    action: "encounter.viewed",
    entityType: "encounter",
    entityId: id,
    summary: "Opened an encounter's invoices",
    detail: { patientId: encounter.patientId },
  });

  return c.json({
    invoices: rows.map(row => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      finalisedAt: iso(row.finalisedAt),
      voidedAt: iso(row.voidedAt),
    })),
  }, HttpStatusCodes.OK);
};
