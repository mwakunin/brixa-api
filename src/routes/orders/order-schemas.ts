import { z } from "@hono/zod-openapi";

import type { ShownOrder } from "@/lib/orders";

import { DRUG_ROUTES } from "@/lib/drug-catalogue";
import { FREQUENCIES } from "@/lib/prescriptions";

/** An order as the orders and prescriptions routes answer with it. */

const PersonSchema = z.object({ membershipId: z.uuid(), name: z.string() });

const MedicineSchema = z.object({
  drugCode: z.string(),
  /** In `doseUnit`, as a decimal. */
  doseAmount: z.string(),
  doseUnit: z.string(),
  route: z.enum(DRUG_ROUTES),
  frequency: z.enum(FREQUENCIES),
  durationDays: z.number().int().nullable(),
  /** In dose units. */
  quantity: z.string(),
  instructions: z.string().nullable(),
  /** Why it was prescribed despite a recorded allergy. */
  allergyOverrideReason: z.string().nullable(),
});

const OrderItemSchema = z.object({
  id: z.uuid(),
  kind: z.enum(["lab", "service", "medication"]),
  labTestId: z.uuid().nullable(),
  /** What it is charged as; none for a medicine, charged when dispensed. */
  billableItemId: z.uuid().nullable(),
  code: z.string(),
  name: z.string(),
  status: z.enum(["ordered", "done", "cancelled"]),
  doneAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancellationReason: z.string().nullable(),
  /** Its standing charge; null once cancelled, or for a medicine. */
  amountCents: z.number().int().nullable(),
  medication: MedicineSchema.nullable(),
});

export const OrderSchema = z.object({
  id: z.uuid(),
  encounterId: z.uuid(),
  urgency: z.enum(["routine", "urgent"]),
  indication: z.string().nullable(),
  orderedAt: z.string(),
  /** The clinician who ordered it; null for a walk-in's request. */
  orderedBy: PersonSchema.nullable(),
  requester: z.object({ name: z.string(), facility: z.string(), licenceNumber: z.string().nullable() }).nullable(),
  selfRequested: z.boolean(),
  enteredBy: PersonSchema,
  /** A prescription's printed document (`/documents/{id}/pdf`); voided once cancelled. */
  prescription: z.object({ documentId: z.uuid(), number: z.string(), voided: z.boolean() }).nullable(),
  items: z.array(OrderItemSchema),
});

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

/** An order as JSON: instants as ISO strings. */
export function orderJson(o: ShownOrder): z.infer<typeof OrderSchema> {
  return {
    ...o,
    orderedAt: o.orderedAt.toISOString(),
    items: o.items.map(i => ({ ...i, doneAt: iso(i.doneAt), cancelledAt: iso(i.cancelledAt) })),
  };
}
