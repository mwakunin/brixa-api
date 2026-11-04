import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { DOCUMENT_READERS } from "@/lib/documents";
import { requireMembershipRole } from "@/middlewares/auth";
import { facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";

/**
 * Invoices on an encounter (SCHEMA.md §7.3). In P2 they bill the patient's
 * account; payers' invoices arrive with their price lists in P7 (rule 21).
 */
const tags = ["Invoices"];

/** Who drafts, finalises and discards invoices. */
export const BILLERS = ["cashier", "billing_clerk", "finance_manager", "facility_admin"] as const;
/** Who may void one already finalised. */
export const FINANCE = ["finance_manager", "facility_admin"] as const;

const billersOnly = requireMembershipRole(...BILLERS);
const readersOnly = requireMembershipRole(...DOCUMENT_READERS.invoice);

const RefusalSchema = z.object({ message: z.string(), code: z.string() });
const IdParamsSchema = z.object({ id: z.uuid() });

const LineSchema = z.object({
  code: z.string(),
  description: z.string(),
  quantity: z.string(),
  unitPriceCents: z.number().int(),
  amountCents: z.number().int(),
  serviceDate: z.string(),
});

const AdjustmentSummarySchema = z.object({
  id: z.uuid(),
  kind: z.enum(["credit_note", "waiver", "write_off"]),
  amountCents: z.number().int(),
  reason: z.string(),
  status: z.enum(["pending", "approved", "rejected", "withdrawn"]),
  /** An approved credit note's number. */
  number: z.string().nullable(),
  requestedAt: z.string(),
  decidedAt: z.string().nullable(),
});

const InvoiceSchema = z.object({
  id: z.uuid(),
  encounterId: z.uuid(),
  kind: z.enum(["interim", "final", "supplementary"]),
  status: z.enum(["draft", "finalised", "void"]),
  /** Issued at finalisation; a draft has none. */
  number: z.string().nullable(),
  accountKind: z.enum(["patient", "payer"]),
  payerName: z.string().nullable(),
  /** A draft's is the sum of its lines; a finalised invoice's is frozen. */
  totalCents: z.number().int(),
  /** Σ live allocations: what payments have settled. */
  paidCents: z.number().int(),
  /** What is still owed on a finalised invoice, after payments and approved adjustments; null otherwise. */
  balanceCents: z.number().int().nullable(),
  createdAt: z.string(),
  finalisedAt: z.string().nullable(),
  voidedAt: z.string().nullable(),
  voidReason: z.string().nullable(),
  lines: z.array(LineSchema),
  /** Credit notes, waivers and write-offs asked for against it; only approved ones count. */
  adjustments: z.array(AdjustmentSummarySchema),
});

const SummarySchema = InvoiceSchema.pick({
  id: true,
  kind: true,
  status: true,
  number: true,
  accountKind: true,
  payerName: true,
  totalCents: true,
  createdAt: true,
  finalisedAt: true,
  voidedAt: true,
});

const DraftBodySchema = z.object({
  /** `final` bills everything not yet billed; `interim` a running bill so far; `supplementary` what came after the final one. */
  kind: z.enum(["interim", "final", "supplementary"]),
});

const VoidBodySchema = z.object({ reason: z.string().trim().min(3).max(200).regex(/^\P{C}+$/u, "One line") });

export const draftInvoice = createRoute({
  tags,
  method: "post",
  path: "/encounters/{id}/invoices",
  summary: "Draft an invoice",
  description: "Bills the patient for every standing charge not yet on a live invoice. A draft has no number until it is finalised.",
  middleware: [billersOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(DraftBodySchema, "Which kind") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(InvoiceSchema, "Drafted"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible as asked"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(DraftBodySchema), "Invalid request"),
    ...tenantResponses,
  },
});

export const listInvoices = createRoute({
  tags,
  method: "get",
  path: "/encounters/{id}/invoices",
  summary: "An encounter's invoices",
  middleware: [readersOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ invoices: z.array(SummarySchema) }), "Invoices, voided ones included"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not an encounter id"),
    ...tenantResponses,
  },
});

export const getInvoice = createRoute({
  tags,
  method: "get",
  path: "/invoices/{id}",
  summary: "An invoice and its lines",
  middleware: [readersOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(InvoiceSchema, "The invoice"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not an invoice id"),
    ...tenantResponses,
  },
});

export const finaliseInvoice = createRoute({
  tags,
  method: "post",
  path: "/invoices/{id}/finalise",
  summary: "Finalise a draft",
  description: "Freezes the total and issues the number and printed invoice. A final invoice needs every standing charge billed.",
  middleware: [billersOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(InvoiceSchema, "Finalised"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible as asked"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not an invoice id"),
    ...tenantResponses,
  },
});

export const voidInvoice = createRoute({
  tags,
  method: "post",
  path: "/invoices/{id}/void",
  summary: "Void an invoice",
  description: "Releases its charges to be billed again. A finalised invoice keeps its number, and only a finance manager or the facility admin voids one.",
  middleware: [billersOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(VoidBodySchema, "Why") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(InvoiceSchema, "Voided"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Already voided"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(VoidBodySchema), "Invalid request"),
    ...tenantResponses,
  },
});

export type DraftInvoiceRoute = typeof draftInvoice;
export type ListInvoicesRoute = typeof listInvoices;
export type GetInvoiceRoute = typeof getInvoice;
export type FinaliseInvoiceRoute = typeof finaliseInvoice;
export type VoidInvoiceRoute = typeof voidInvoice;
