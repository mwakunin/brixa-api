import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { DOCUMENT_READERS } from "@/lib/documents";
import { requireMembershipRole } from "@/middlewares/auth";
import { facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";
import { BILLERS, FINANCE } from "@/routes/invoices/invoices.routes";
import { CASHIERS } from "@/routes/shifts/shifts.routes";

/**
 * M-Pesa (P2 slice 6): the facility admin sets up the paybill (decided
 * 2026-11-06); payments matched by nothing wait in a queue for a biller;
 * cashiers prompt a patient's phone to pay (STK push).
 */
const tags = ["M-Pesa"];

const adminOnly = requireMembershipRole("facility_admin");
const billersOnly = requireMembershipRole(...BILLERS);
const financeOnly = requireMembershipRole(...FINANCE);
const cashiersOnly = requireMembershipRole(...CASHIERS);
const readersOnly = requireMembershipRole(...DOCUMENT_READERS.receipt);

const RefusalSchema = z.object({ message: z.string(), code: z.string() });
const IdParamsSchema = z.object({ id: z.uuid() });
const Cents = z.number().int().positive().max(25_000_000).refine(c => c % 100 === 0, "Whole shillings only");
const Secret = z.string().trim().min(8).max(200);

const SettingsSchema = z.object({
  shortcode: z.string(),
  /** Null until Safaricom accepts the paybill's callback URLs. */
  urlsRegisteredAt: z.string().nullable(),
  lastRegistrationError: z.string().nullable(),
  /** Contain this facility's secret callback token. */
  callbackUrls: z.object({ confirmation: z.string(), validation: z.string(), stk: z.string() }),
});

const SettingsBodySchema = z.object({
  shortcode: z.string().regex(/^\d{5,7}$/, "The paybill number"),
  consumerKey: Secret,
  consumerSecret: Secret,
  passkey: Secret,
});

export const getSettings = createRoute({
  tags,
  method: "get",
  path: "/mpesa/settings",
  summary: "This facility's M-Pesa paybill",
  description: "Never shows the credentials, only the paybill and whether Safaricom has its callback URLs.",
  middleware: [adminOnly] as const,
  request: { headers: facilityHeaders },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ settings: SettingsSchema.nullable() }), "The settings, or null"),
    ...tenantResponses,
  },
});

export const putSettings = createRoute({
  tags,
  method: "put",
  path: "/mpesa/settings",
  summary: "Set the M-Pesa paybill and its Daraja credentials",
  description: "Stored encrypted. The callback URLs are then registered with Safaricom in the background.",
  middleware: [adminOnly] as const,
  request: { headers: facilityHeaders, body: jsonContentRequired(SettingsBodySchema, "The paybill") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ settings: SettingsSchema }), "Saved"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(SettingsBodySchema), "Invalid settings"),
    ...tenantResponses,
  },
});

const StatusSchema = z.enum(["unmatched", "allocated", "rejected"]);

const TransactionSchema = z.object({
  id: z.uuid(),
  source: z.enum(["c2b", "stk"]),
  /** Safaricom's receipt number. */
  transactionId: z.string(),
  /** What the payer typed as the account number. */
  accountReference: z.string().nullable(),
  msisdn: z.string(),
  payerName: z.string().nullable(),
  amountCents: z.number().int(),
  transactedAt: z.string(),
  status: StatusSchema,
  statusReason: z.string().nullable(),
  /** The live payment it became, once placed. */
  paymentId: z.uuid().nullable(),
});

const TransactionQuerySchema = z.object({
  status: StatusSchema.optional(),
  /** Safaricom's receipt number, as the payer reads it out. */
  transactionId: z.string().trim().regex(/^[A-Z0-9]{8,12}$/i, "An M-Pesa receipt number").optional(),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const listTransactions = createRoute({
  tags,
  method: "get",
  path: "/mpesa/transactions",
  summary: "M-Pesa transactions, newest first",
  description: "`?status=unmatched` is the queue of payments nothing matched; `?transactionId=` finds one by its receipt number. 100 a page, `?offset=` for older. Audited: it shows payers' names and phones.",
  middleware: [readersOnly] as const,
  request: { headers: facilityHeaders, query: TransactionQuerySchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ transactions: z.array(TransactionSchema) }), "Transactions"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(TransactionQuerySchema), "Unknown filter"),
    ...tenantResponses,
  },
});

const AssignBodySchema = z.object({
  patientId: z.uuid(),
  /** Settle this bill with it. */
  invoiceId: z.uuid().optional(),
  /** Or hold it as a deposit for this visit or admission. */
  encounterId: z.uuid().optional(),
}).refine(b => !(b.invoiceId && b.encounterId), { message: "Name the bill or the visit, not both", path: ["encounterId"] });

const actionResponses = {
  [HttpStatusCodes.OK]: jsonContent(TransactionSchema, "Done"),
  [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible as asked"),
  ...tenantResponses,
};

export const assignTransaction = createRoute({
  tags,
  method: "post",
  path: "/mpesa/transactions/{id}/assign",
  summary: "Place an unmatched M-Pesa payment",
  description: "On a patient's account, and optionally against their bill or visit. Issues its receipt.",
  middleware: [billersOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(AssignBodySchema, "Where it goes") },
  responses: {
    ...actionResponses,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(AssignBodySchema), "Invalid request"),
  },
});

const ReasonSchema = z.object({ reason: z.string().trim().min(3).max(200).regex(/^\P{C}+$/u, "One line") });

export const rejectTransaction = createRoute({
  tags,
  method: "post",
  path: "/mpesa/transactions/{id}/reject",
  summary: "Set aside an unmatched M-Pesa payment",
  description: "For example, paid in error and reversed with Safaricom. Kept, never placed.",
  middleware: [financeOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(ReasonSchema, "Why") },
  responses: {
    ...actionResponses,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(ReasonSchema), "Invalid request"),
  },
});

const StkRequestSchema = z.object({
  id: z.uuid(),
  patientId: z.uuid(),
  invoiceId: z.uuid().nullable(),
  encounterId: z.uuid().nullable(),
  phone: z.string(),
  amountCents: z.number().int(),
  /** `queued`, `sending`, then `sent` once Safaricom has it; `completed` when paid, or `failed`. */
  status: z.enum(["queued", "sending", "sent", "completed", "failed"]),
  resultDesc: z.string().nullable(),
  /** The M-Pesa receipt number, once paid. */
  receiptNumber: z.string().nullable(),
  /** The payment it became, and whether finance has since reversed it. */
  paymentId: z.uuid().nullable(),
  paymentReversed: z.boolean(),
  requestedAt: z.string(),
});

const StkBodySchema = z.object({
  patientId: z.uuid(),
  /** The phone to prompt, e.g. 0712 345 678. */
  phone: z.string().trim().min(9).max(16),
  amountCents: Cents,
  invoiceId: z.uuid().optional(),
  encounterId: z.uuid().optional(),
}).refine(b => !(b.invoiceId && b.encounterId), { message: "Name the bill or the visit, not both", path: ["encounterId"] });

export const requestStk = createRoute({
  tags,
  method: "post",
  path: "/mpesa/stk",
  summary: "Prompt a patient's phone to pay",
  description: "Sent to Safaricom in the background. Poll the request: the payment is recorded when the patient pays.",
  middleware: [cashiersOnly] as const,
  request: { headers: facilityHeaders, body: jsonContentRequired(StkBodySchema, "The prompt") },
  responses: {
    [HttpStatusCodes.ACCEPTED]: jsonContent(StkRequestSchema, "Queued"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible as asked"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(StkBodySchema), "Invalid prompt"),
    ...tenantResponses,
  },
});

export const getStk = createRoute({
  tags,
  method: "get",
  path: "/mpesa/stk/{id}",
  summary: "An M-Pesa prompt and its outcome",
  middleware: [cashiersOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(StkRequestSchema, "The prompt"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not a prompt id"),
    ...tenantResponses,
  },
});

export type GetSettingsRoute = typeof getSettings;
export type PutSettingsRoute = typeof putSettings;
export type ListTransactionsRoute = typeof listTransactions;
export type AssignTransactionRoute = typeof assignTransaction;
export type RejectTransactionRoute = typeof rejectTransaction;
export type RequestStkRoute = typeof requestStk;
export type GetStkRoute = typeof getStk;
