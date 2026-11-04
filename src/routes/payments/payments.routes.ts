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
 * Payments and allocations (SCHEMA.md §7.4). A payment is credit on the
 * patient's account with its receipt; taken against a bill, as much as the
 * bill owes is applied at once. Reversals are finance's, never the person's
 * who took the money (decided 2026-11-04).
 */
const tags = ["Payments"];

const cashiersOnly = requireMembershipRole(...CASHIERS);
const billersOnly = requireMembershipRole(...BILLERS);
const financeOnly = requireMembershipRole(...FINANCE);
const readersOnly = requireMembershipRole(...DOCUMENT_READERS.receipt);

const RefusalSchema = z.object({ message: z.string(), code: z.string() });
const IdParamsSchema = z.object({ id: z.uuid() });
const Cents = z.number().int().positive().max(2_000_000_000).refine(c => c % 100 === 0, "Whole shillings only");
const ReasonSchema = z.object({ reason: z.string().trim().min(3).max(200).regex(/^\P{C}+$/u, "One line") });

const AllocationSchema = z.object({
  id: z.uuid(),
  invoiceId: z.uuid(),
  invoiceNumber: z.string().nullable(),
  amountCents: z.number().int(),
  allocatedAt: z.string(),
  reversedAt: z.string().nullable(),
});

const PaymentSchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  method: z.enum(["cash", "card", "bank"]),
  amountCents: z.number().int(),
  reference: z.string().nullable(),
  cashierShiftId: z.uuid().nullable(),
  encounterId: z.uuid().nullable(),
  receiptNumber: z.string(),
  documentId: z.uuid(),
  receivedAt: z.string(),
  receivedBy: z.uuid(),
  reversedAt: z.string().nullable(),
  reversalReason: z.string().nullable(),
  /** Credit still on the account from this payment. */
  unallocatedCents: z.number().int(),
  allocations: z.array(AllocationSchema),
});

const RecordBodySchema = z.object({
  patientId: z.uuid(),
  method: z.enum(["cash", "card", "bank"]),
  amountCents: Cents,
  /** The card slip's or bank transfer's reference; required for those, refused for cash. */
  reference: z.string().trim().min(3).max(40).regex(/^[\w /-]+$/, "Letters, digits, spaces, / and -").optional(),
  /** Paid against this bill: as much as it owes is applied now, the rest kept as credit. */
  invoiceId: z.uuid().optional(),
  /** Paid towards this visit or admission (a deposit), applied when its bill is finalised. */
  encounterId: z.uuid().optional(),
}).refine(b => (b.method === "cash") === (b.reference === undefined), {
  message: "Card and bank payments need a reference; cash has none",
  path: ["reference"],
}).refine(b => !(b.invoiceId && b.encounterId), {
  message: "Name the bill or the visit, not both",
  path: ["encounterId"],
});

export const recordPayment = createRoute({
  tags,
  method: "post",
  path: "/payments",
  summary: "Receive a payment",
  description: "Issues its receipt. Cash and card need my open shift.",
  middleware: [cashiersOnly] as const,
  request: { headers: facilityHeaders, body: jsonContentRequired(RecordBodySchema, "The payment") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(PaymentSchema, "Received"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible as asked"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(RecordBodySchema), "Invalid payment"),
    ...tenantResponses,
  },
});

export const getPayment = createRoute({
  tags,
  method: "get",
  path: "/payments/{id}",
  summary: "A payment and where it went",
  middleware: [readersOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(PaymentSchema, "The payment"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not a payment id"),
    ...tenantResponses,
  },
});

export const reversePayment = createRoute({
  tags,
  method: "post",
  path: "/payments/{id}/reverse",
  summary: "Reverse a payment recorded in error",
  description: "Voids its receipt; its allocations stop counting. Not by whoever took it.",
  middleware: [financeOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(ReasonSchema, "Why") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(PaymentSchema, "Reversed"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible as asked"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(ReasonSchema), "Invalid request"),
    ...tenantResponses,
  },
});

const AllocateBodySchema = z.object({
  invoiceId: z.uuid(),
  /** Defaults to as much as the payment has left and the bill owes. */
  amountCents: Cents.optional(),
});

export const allocatePayment = createRoute({
  tags,
  method: "post",
  path: "/payments/{id}/allocations",
  summary: "Apply credit to a bill",
  middleware: [billersOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(AllocateBodySchema, "Which bill") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(PaymentSchema, "Applied"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible as asked"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(AllocateBodySchema), "Invalid request"),
    ...tenantResponses,
  },
});

export const reverseAllocation = createRoute({
  tags,
  method: "post",
  path: "/allocations/{id}/reverse",
  summary: "Un-apply credit from a bill",
  description: "The money returns to the payment's credit.",
  middleware: [financeOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(ReasonSchema, "Why") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(PaymentSchema, "Reversed"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Already reversed"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(ReasonSchema), "Invalid request"),
    ...tenantResponses,
  },
});

const AccountSchema = z.object({
  /** Credit not yet applied to any bill: deposits and overpayments. */
  creditCents: z.number().int(),
  /** What finalised bills still owe. */
  owedCents: z.number().int(),
  credit: z.array(z.object({ paymentId: z.uuid(), encounterId: z.uuid().nullable(), receivedAt: z.string(), unallocatedCents: z.number().int() })),
  invoices: z.array(z.object({ id: z.uuid(), number: z.string(), encounterId: z.uuid(), totalCents: z.number().int(), balanceCents: z.number().int() })),
});

export const getAccount = createRoute({
  tags,
  method: "get",
  path: "/patients/{id}/account",
  summary: "A patient's account",
  description: "Credit and what each finalised bill still owes. Audited.",
  middleware: [readersOnly] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(AccountSchema, "The account"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not a patient id"),
    ...tenantResponses,
  },
});

export type RecordPaymentRoute = typeof recordPayment;
export type GetPaymentRoute = typeof getPayment;
export type ReversePaymentRoute = typeof reversePayment;
export type AllocatePaymentRoute = typeof allocatePayment;
export type ReverseAllocationRoute = typeof reverseAllocation;
export type GetAccountRoute = typeof getAccount;
