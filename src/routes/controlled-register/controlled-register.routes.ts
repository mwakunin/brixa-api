import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { REGISTER_READERS } from "@/lib/controlled-register";
import { requireMembershipRole } from "@/middlewares/auth";
import { facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";

/**
 * The controlled-drug register (rule 12): written by the stock ledger itself,
 * read by the pharmacist in charge, the facility admin and the auditor.
 */
const tags = ["Controlled drugs"];
const readers = requireMembershipRole(...REGISTER_READERS);

const PersonSchema = z.object({ name: z.string(), licence: z.string().nullable() }).nullable();
const KINDS = ["brought_forward", "receipt", "receipt_reversed", "transfer_out", "transfer_in", "dispense", "dispense_cancelled", "dispense_returned", "adjustment"] as const;

const PageSchema = z.object({
  drug: z.object({ code: z.string(), genericName: z.string(), strength: z.string(), form: z.string(), controlledSchedule: z.string().nullable() }),
  store: z.object({ id: z.uuid(), name: z.string() }),
  /** Before the first line shown. */
  balanceBefore: z.number(),
  lines: z.array(z.object({
    at: z.string(),
    kind: z.enum(KINDS),
    batchNumber: z.string().nullable(),
    expiresOn: z.string().nullable(),
    quantityIn: z.number(),
    quantityOut: z.number(),
    balance: z.number(),
    patient: z.object({ id: z.uuid(), name: z.string(), opNumber: z.string().nullable() }).nullable(),
    /** With the licence they held at the time. */
    prescriber: PersonSchema,
    recordedBy: PersonSchema,
  })),
});

const QuerySchema = z.object({
  drugCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9._/-]{0,31}$/, "A catalogue drug code"),
  storeId: z.uuid(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
}).refine(q => !q.from || !q.to || q.from <= q.to, { message: "From before to", path: ["to"] });

export const viewRegister = createRoute({
  tags,
  method: "get",
  path: "/controlled-register",
  summary: "A controlled drug's register in a store",
  description:
    "Every movement of the drug there, oldest first, 500 at a time (`?offset=` for the next), with the "
    + "running balance, the patient, the prescriber and who moved it, each with their licence then. Audited.",
  middleware: [readers] as const,
  request: { headers: facilityHeaders, query: QuerySchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(PageSchema, "The register's page"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(QuerySchema), "Invalid page"),
    ...tenantResponses,
  },
});

export type ViewRegisterRoute = typeof viewRegister;
