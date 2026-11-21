import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { DISPENSERS } from "@/lib/dispensing";
import { ONE_LINE } from "@/lib/validation";
import { requireClinicalRole } from "@/middlewares/auth";
import { clinicalResponses, facilityHeaders } from "@/routes/facility/facility.routes";

/**
 * The pharmacy: its list of prescriptions waiting, and preparing, handing
 * over and cancelling a dispense. Pharmacists and pharmacy technicians,
 * under a current licence; a controlled drug, a pharmacist with a pharmacy
 * licence.
 */
const tags = ["Dispensing"];
const dispensers = requireClinicalRole(...DISPENSERS);

const RefusalSchema = z.object({ message: z.string(), code: z.string(), line: z.number().optional() });
const IdParamsSchema = z.object({ id: z.uuid() });
const ReasonSchema = z.string().trim().min(3).max(200).regex(ONE_LINE, "One line");
const QuantitySchema = z.number().int().min(1).max(100_000);
const lower = (id: string) => id.toLowerCase();

const PatientSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  opNumber: z.string().nullable(),
  sex: z.enum(["male", "female", "intersex"]).nullable(),
  ageYears: z.number().int(),
});
const StepSchema = z.object({ byName: z.string(), at: z.string() });

const DispenseSchema = z.object({
  id: z.uuid(),
  status: z.enum(["prepared", "handed_over", "cancelled"]),
  orderId: z.uuid(),
  number: z.string(),
  encounterId: z.uuid(),
  patient: PatientSchema,
  store: z.object({ id: z.uuid(), name: z.string() }),
  prepared: StepSchema,
  handedOver: StepSchema.nullable(),
  cancelled: StepSchema.extend({ reason: z.string() }).nullable(),
  /** An outpatient's medicines not yet paid for: a warning, never a block. */
  unpaid: z.boolean(),
  lines: z.array(z.object({
    /** What a patient's return names (`/dispense-lines/{id}/returns`). */
    id: z.uuid(),
    orderItemId: z.uuid(),
    description: z.string(),
    stockItemId: z.uuid(),
    code: z.string(),
    name: z.string(),
    baseUnit: z.string(),
    quantity: z.number(),
    completes: z.boolean(),
    amountCents: z.number(),
    batches: z.array(z.object({ batchId: z.uuid(), batchNumber: z.string().nullable(), expiresOn: z.string().nullable(), quantity: z.number() })),
  })),
});

const WorklistSchema = z.object({
  waiting: z.array(z.object({
    orderId: z.uuid(),
    number: z.string(),
    encounterId: z.uuid(),
    patient: PatientSchema,
    prescribedByName: z.string().nullable(),
    orderedAt: z.string(),
    medicines: z.array(z.object({
      orderItemId: z.uuid(),
      drugCode: z.string(),
      description: z.string(),
      doseUnit: z.string(),
      quantity: z.number(),
      /** Handed over so far, in the prescription's dose unit. */
      given: z.number(),
      /** Some was handed over in another unit (a bottle for mL), which `given` does not count. */
      givenOtherUnits: z.boolean(),
      prepared: z.boolean(),
      controlledSchedule: z.string().nullable(),
      /**
       * `out`: the pharmacy holds nothing in date that fills it. `low`: less than is still owed,
       * told only when all it holds is in the prescription's dose unit. Null flags nothing.
       */
      stockFlag: z.enum(["low", "out"]).nullable(),
    })),
  })),
  /** Prepared, not yet collected: handed over, or cancelled to put the stock back. */
  prepared: z.array(DispenseSchema),
  /** The pharmacy whose shelf the flags measure; null when the facility has several and none was named, so nothing is flagged. */
  stockIn: z.object({ id: z.uuid(), name: z.string() }).nullable(),
});

const WorklistQuerySchema = z.object({
  /** The pharmacy to flag stock against; the facility's only one unless given. */
  storeId: z.uuid().optional(),
});

const QuoteSchema = z.object({
  lines: z.array(z.object({
    orderItemId: z.uuid(),
    stockItemId: z.uuid(),
    code: z.string(),
    name: z.string(),
    baseUnit: z.string(),
    quantity: z.number(),
    completes: z.boolean(),
    /** Per base unit, on the cash price list today. */
    unitPriceCents: z.number(),
    /** The charge preparing it would raise: the unit price times the quantity, rounded to whole shillings once. */
    amountCents: z.number(),
  })),
  totalCents: z.number(),
});

const PrepareLineSchema = z.strictObject({
  orderItemId: z.uuid(),
  stockItemId: z.uuid(),
  /** In the item's base unit; where it is the prescription's unit, what is still owed unless given. */
  quantity: QuantitySchema.optional(),
  /** The batches to take it from, instead of earliest expiry first. */
  batches: z.array(z.strictObject({ batchId: z.uuid(), quantity: QuantitySchema })).min(1).max(10).refine(b => new Set(b.map(x => lower(x.batchId))).size === b.length, "Each batch once").optional(),
  /** In units other than the prescription's: false when more is to come. */
  complete: z.boolean().optional(),
}).refine(l => l.quantity === undefined || l.batches === undefined, { message: "A quantity or the batches, not both", path: ["quantity"] });

const PrepareBodySchema = z.strictObject({
  /** The prescription. */
  orderId: z.uuid(),
  /** The pharmacy; the facility's only one unless given. */
  storeId: z.uuid().optional(),
  lines: z.array(PrepareLineSchema).min(1).max(30).refine(l => new Set(l.map(x => lower(x.orderItemId))).size === l.length, "Each medicine once"),
});

const CancelBodySchema = z.strictObject({ reason: ReasonSchema });

const NotSuppliedBodySchema = z.strictObject({
  reason: z.enum(["out_of_stock", "patient_declined", "buying_elsewhere", "other"]),
  /** Needed for `other`. */
  note: ReasonSchema.optional(),
}).refine(b => b.reason !== "other" || b.note !== undefined, { message: "Say what, for other", path: ["note"] });

const refusals = {
  [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible as the prescription, visit or stock are"),
};
const forbidden = {
  [HttpStatusCodes.FORBIDDEN]: jsonContent(
    z.union([z.object({ message: z.string(), code: z.enum(["licence_expired", "controlled_dispenser"]) }), z.object({ message: z.string() })]),
    "Role not allowed, a lapsed licence (`licence_expired`), or a controlled drug from anyone but a pharmacist with a pharmacy licence (`controlled_dispenser`)",
  ),
};

export const worklist = createRoute({
  tags,
  method: "get",
  path: "/pharmacy/worklist",
  summary: "The pharmacy's list",
  description:
    "Prescriptions on open visits with a medicine still to give, oldest first, and dispenses prepared and not collected. "
    + "Each medicine is flagged when the pharmacy is low on it or out of it, measured against that medicine alone. Audited.",
  middleware: [dispensers] as const,
  request: { headers: facilityHeaders, query: WorklistQuerySchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(WorklistSchema, "The list"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "The store named is not an open pharmacy of this facility (`not_a_pharmacy`)"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(WorklistQuerySchema), "Not a store id"),
    ...clinicalResponses,
  },
});

export const getDispense = createRoute({
  tags,
  method: "get",
  path: "/dispenses/{id}",
  summary: "One dispense",
  description: "Audited, as it names its patient and medicines.",
  middleware: [dispensers] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(DispenseSchema, "The dispense"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not a dispense id"),
    ...clinicalResponses,
  },
});

export const prepare = createRoute({
  tags,
  method: "post",
  path: "/dispenses",
  summary: "Prepare a prescription",
  description:
    "Takes each medicine's stock from the pharmacy, earliest expiry first (never an expired batch) unless batches are named, "
    + "and charges it at the item's price per base unit. A refused line refuses the whole dispense, naming the line.",
  middleware: [dispensers] as const,
  request: { headers: facilityHeaders, body: jsonContentRequired(PrepareBodySchema, "What to give") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(DispenseSchema, "Prepared"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(PrepareBodySchema), "Invalid dispense"),
    ...clinicalResponses,
    ...forbidden,
  },
});

export const quote = createRoute({
  tags,
  method: "post",
  path: "/dispenses/quote",
  summary: "Quote a prescription before preparing it",
  description:
    "Each line's charge and the total, for the items and quantities given, so the patient can decide how much to buy. "
    + "Checked and refused exactly as preparing would be, with the same body; nothing is taken, charged or recorded.",
  middleware: [dispensers] as const,
  request: { headers: facilityHeaders, body: jsonContentRequired(PrepareBodySchema, "What would be given") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(QuoteSchema, "The quote"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(PrepareBodySchema), "Invalid dispense"),
    ...clinicalResponses,
    ...forbidden,
  },
});

export const handOver = createRoute({
  tags,
  method: "post",
  path: "/dispenses/{id}/hand-over",
  summary: "Hand a prepared dispense over",
  description: "Finishes each medicine it completes. A controlled drug is handed over by a pharmacist with a pharmacy licence. Never held up over money: `unpaid` says whether it is paid for.",
  middleware: [dispensers] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(DispenseSchema, "Handed over"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(IdParamsSchema), "Not a dispense id"),
    ...clinicalResponses,
    ...forbidden,
  },
});

export const cancel = createRoute({
  tags,
  method: "post",
  path: "/dispenses/{id}/cancel",
  summary: "Cancel a prepared dispense",
  description: "Puts its stock back and cancels its charges, while none is on a bill; once billed, it is a return.",
  middleware: [dispensers] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(CancelBodySchema, "Why") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(DispenseSchema, "Cancelled"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(CancelBodySchema), "Invalid reason"),
    ...clinicalResponses,
  },
});

export const notSupplied = createRoute({
  tags,
  method: "post",
  path: "/order-items/{id}/not-supplied",
  summary: "Mark a medicine, or the rest of it, not supplied",
  description: "Ends it without a charge for what was not given, so the visit can close.",
  middleware: [dispensers] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(NotSuppliedBodySchema, "Why") },
  responses: {
    [HttpStatusCodes.NO_CONTENT]: { description: "Marked" },
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(NotSuppliedBodySchema), "Invalid reason"),
    ...clinicalResponses,
  },
});

export type WorklistRoute = typeof worklist;
export type GetDispenseRoute = typeof getDispense;
export type PrepareRoute = typeof prepare;
export type QuoteRoute = typeof quote;
export type HandOverRoute = typeof handOver;
export type CancelRoute = typeof cancel;
export type NotSuppliedRoute = typeof notSupplied;
