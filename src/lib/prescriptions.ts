import { and, desc, eq, gte, isNull, lt } from "drizzle-orm";

import type { AppDb } from "@/db";
import type { MembershipRole } from "@/db/schema";

import { drugCatalogue, encounters, memberships, observations, orderItems, orders, patientAllergies, patientNumbers, patients, user } from "@/db/schema";

import type { PrintedContent } from "./document-content";
import type { Drug, DrugRoute } from "./drug-catalogue";
import type { OrderActor } from "./orders";
import type { PatientActor } from "./patients";

import { recordAudit } from "./audit";
import { addDays, ageInYears, businessDate, printedAge, printedDate, startOfBusinessDay } from "./dates";
import { issueDocument, voidDocument } from "./documents";
import { currentDrug, describeDrug, ingredientsOf } from "./drug-catalogue";
import { printedQuantity } from "./money";
import { PROFESSIONS } from "./professions";

/**
 * Prescriptions (SCHEMA.md §8, P3 slice 4b): medicines ordered on an open
 * encounter, as one order whose printed `RX-` document is issued as it is
 * signed (rule 20's pattern: the number and the frozen content commit with
 * the order). Not charged: the charge comes with dispensing (P4).
 *
 * Decided 2026-11-11: doctors, clinical officers and nurses prescribe, and
 * only doctors and clinical officers a controlled drug; a drug the patient
 * is recorded as allergic to (by generic name) is refused unless the
 * prescriber gives a reason, which is audited; a child under 12 needs a
 * weight taken that day. A prescription is changed by cancelling it, which
 * voids its paper, and writing a new one.
 */

type OrderRow = typeof orders.$inferSelect;
type ItemRow = typeof orderItems.$inferSelect;
export type Frequency = NonNullable<ItemRow["frequency"]>;

/** Who prescribes a controlled drug. */
const CONTROLLED_PRESCRIBERS: readonly MembershipRole[] = ["doctor", "clinical_officer"];

/** Below this age, a prescription needs a weight taken that day. To be confirmed by a clinician. */
export const CHILD_UNDER_YEARS = 12;

export const FREQUENCIES = ["od", "bd", "tds", "qid", "nocte", "prn", "stat"] as const satisfies readonly Frequency[];

/** Doses a day at a regular frequency, from which a quantity is worked out. */
const DOSES_A_DAY: Partial<Record<Frequency, number>> = { od: 1, bd: 2, tds: 3, qid: 4, nocte: 1 };

const FREQUENCY_LABELS: Record<Frequency, string> = {
  od: "Once daily (OD)",
  bd: "Twice daily (BD)",
  tds: "Three times daily (TDS)",
  qid: "Four times daily (QID)",
  nocte: "At night (nocte)",
  prn: "When needed (PRN)",
  stat: "Once, now (STAT)",
};

const ROUTE_LABELS: Record<DrugRoute, string> = {
  oral: "Oral",
  sublingual: "Sublingual",
  iv: "IV",
  im: "IM",
  sc: "SC",
  intradermal: "Intradermal",
  topical: "Topical",
  rectal: "Rectal",
  vaginal: "Vaginal",
  inhaled: "Inhaled",
  nasal: "Nasal",
  ophthalmic: "Eye",
  otic: "Ear",
};

export interface MedicineInput {
  drugCode: string;
  /** Each dose, in the drug's dose unit, as a decimal: "1", "0.5", "5". */
  doseAmount: string;
  /** The drug's usual route unless given. */
  route?: DrugRoute;
  frequency: Frequency;
  /** Required at a regular frequency; none for a single dose (stat). */
  durationDays?: number;
  /** In dose units; worked out from a regular frequency, or a single dose, unless given. */
  quantity?: string;
  instructions?: string;
  /** Why to prescribe it despite a recorded allergy to it. */
  allergyOverride?: string;
}

/** A recorded allergy that a drug on the prescription matches. */
export interface AllergyMatch {
  drugCode: string;
  allergen: string;
  reaction: string | null;
  severity: string | null;
}

export type PrescriptionErrorCode
  = | "encounter_not_found"
    | "not_open"
    | "drug_not_found"
    | "duplicate_drug"
    | "quantity_needed"
    | "drug_allergy"
    | "weight_needed"
    | "controlled_prescriber"
    | "not_found"
    | "already_cancelled";

const MESSAGES: Record<Exclude<PrescriptionErrorCode, "drug_allergy">, string> = {
  encounter_not_found: "No such encounter",
  not_open: "A prescription is written on an open encounter",
  drug_not_found: "No such drug in the catalogue",
  duplicate_drug: "The same drug is on this prescription twice",
  quantity_needed: "Give the quantity for a drug taken when needed",
  weight_needed: `A child under ${CHILD_UNDER_YEARS} needs a weight taken today before anything is prescribed; record it with the vital signs`,
  controlled_prescriber: "Only a doctor or a clinical officer prescribes a controlled drug",
  not_found: "No such prescription",
  already_cancelled: "Nothing on this prescription is left to cancel",
};

function allergyMessage(matches: AllergyMatch[]): string {
  const told = matches.map(m => (m.reaction ? `${m.allergen} (${m.reaction})` : m.allergen));
  return `The patient is recorded as allergic to ${[...new Set(told)].join(", ")}. Give a reason to prescribe it anyway, or choose another drug.`;
}

export class PrescriptionError extends Error {
  constructor(readonly code: PrescriptionErrorCode, readonly allergies: AllergyMatch[] = []) {
    super(code === "drug_allergy" ? allergyMessage(allergies) : MESSAGES[code]);
    this.name = "PrescriptionError";
  }
}

/** A dose as a count of thousandths, so quantities are worked out exactly. */
function thousandths(decimal: string): number {
  return Math.round(Number(decimal) * 1000);
}

/** What to supply, in dose units. */
function quantityOf(item: MedicineInput): string {
  if (item.quantity)
    return item.quantity;
  const dose = thousandths(item.doseAmount);
  if (item.frequency === "stat")
    return (dose / 1000).toFixed(3);
  const perDay = DOSES_A_DAY[item.frequency];
  if (!perDay || !item.durationDays)
    throw new PrescriptionError("quantity_needed");
  return (dose * perDay * item.durationDays / 1000).toFixed(3);
}

/** Standing drug allergies the drugs match, by generic name or ingredient, per drug code. */
async function allergyMatches(tx: AppDb, patientId: string, drugs: Drug[]): Promise<Map<string, AllergyMatch[]>> {
  const recorded = await tx
    .select({ allergen: patientAllergies.allergen, reaction: patientAllergies.reaction, severity: patientAllergies.severity, drugName: drugCatalogue.genericName })
    .from(patientAllergies)
    .leftJoin(drugCatalogue, eq(drugCatalogue.code, patientAllergies.drugCode))
    .where(and(eq(patientAllergies.patientId, patientId), eq(patientAllergies.category, "drug"), isNull(patientAllergies.removedAt)));

  const matches = new Map<string, AllergyMatch[]>();
  for (const drug of drugs) {
    const ingredients = ingredientsOf(drug.genericName);
    const found = recorded
      .filter(a => [...ingredientsOf(a.allergen!), ...(a.drugName ? ingredientsOf(a.drugName) : [])].some(n => ingredients.includes(n)))
      .map(a => ({ drugCode: drug.code, allergen: a.allergen!, reaction: a.reaction, severity: a.severity }));
    if (found.length > 0)
      matches.set(drug.code, found);
  }
  return matches;
}

/** The patient's latest weight taken on `today`, on any of their encounters, in kg; null if none. */
async function weightOn(tx: AppDb, patientId: string, today: string): Promise<string | null> {
  const [taken] = await tx
    .select({ value: observations.value })
    .from(observations)
    .innerJoin(encounters, eq(encounters.id, observations.encounterId))
    .where(and(
      eq(encounters.patientId, patientId),
      eq(observations.code, "weight"),
      isNull(observations.enteredInErrorAt),
      gte(observations.observedAt, startOfBusinessDay(today)),
      lt(observations.observedAt, startOfBusinessDay(addDays(today, 1))),
    ))
    .orderBy(desc(observations.observedAt))
    .limit(1);
  return taken?.value ?? null;
}

interface Line {
  drug: Drug;
  input: MedicineInput;
  route: DrugRoute;
  quantity: string;
  overridden: AllergyMatch[];
}

async function printedPrescription(
  tx: AppDb,
  patientId: string,
  lines: Line[],
  input: { indication: string | null; weight: string | null; today: string },
  actor: PatientActor,
): Promise<PrintedContent> {
  const [patient] = await tx.select().from(patients).where(eq(patients.id, patientId)).limit(1);
  const [op] = await tx
    .select({ number: patientNumbers.number })
    .from(patientNumbers)
    .where(and(eq(patientNumbers.patientId, patientId), eq(patientNumbers.kind, "outpatient")))
    .limit(1);
  const [prescriber] = await tx
    .select({ name: user.name, profession: memberships.licenceProfession, licence: memberships.licenceNumber })
    .from(memberships)
    .innerJoin(user, eq(user.id, memberships.userId))
    .where(eq(memberships.id, actor.membershipId))
    .limit(1);
  const allergies = await tx
    .select({ category: patientAllergies.category, allergen: patientAllergies.allergen, reaction: patientAllergies.reaction })
    .from(patientAllergies)
    .where(and(eq(patientAllergies.patientId, patientId), isNull(patientAllergies.removedAt)));

  const told = allergies.filter(a => a.category !== "none_known").map(a => (a.reaction ? `${a.allergen} (${a.reaction})` : a.allergen!));
  const allergyLine = told.length > 0 ? told.join("; ") : allergies.length > 0 ? "No known allergies" : "Not recorded";
  const name = [patient.givenName, patient.middleNames, patient.familyName].filter(Boolean).join(" ");
  const sex = patient.sex ? `${patient.sex[0].toUpperCase()}${patient.sex.slice(1)}, ` : "";
  const council = prescriber.profession ? PROFESSIONS[prescriber.profession].council : "";

  return {
    title: "Prescription",
    fields: [
      { label: "Patient", value: name },
      { label: "Patient number", value: op?.number ?? "" },
      { label: "Sex and age", value: `${sex}${printedAge(patient.dateOfBirth, input.today)}` },
      ...(input.weight ? [{ label: "Weight", value: `${printedQuantity(input.weight)} kg, taken ${printedDate(input.today)}` }] : []),
      { label: "Allergies", value: allergyLine.slice(0, 500) },
      ...(input.indication ? [{ label: "For", value: input.indication }] : []),
      { label: "Prescriber", value: `${prescriber.name}, ${council} licence ${prescriber.licence ?? ""}`.trim() },
      { label: "Date", value: printedDate(input.today) },
    ],
    table: {
      columns: [
        { label: "Medicine" },
        { label: "Dose" },
        { label: "Route" },
        { label: "How often" },
        { label: "Days", align: "right" },
        { label: "Quantity", align: "right" },
        { label: "Instructions" },
      ],
      rows: lines.map(l => [
        `${describeDrug(l.drug)}${l.drug.controlledSchedule ? ` (controlled, Schedule ${l.drug.controlledSchedule})` : ""}`,
        `${printedQuantity(Number(l.input.doseAmount).toFixed(3))} ${l.drug.doseUnit}`,
        ROUTE_LABELS[l.route],
        FREQUENCY_LABELS[l.input.frequency],
        l.input.durationDays ? String(l.input.durationDays) : "",
        `${printedQuantity(l.quantity)} ${l.drug.doseUnit}`,
        l.input.instructions ?? "",
      ]),
    },
    notes: lines
      .filter(l => l.overridden.length > 0)
      .map(l => `${l.drug.genericName} prescribed despite a recorded allergy to ${[...new Set(l.overridden.map(o => o.allergen))].join(", ")}: ${l.input.allergyOverride}`),
  };
}

/**
 * Writes a prescription on an open encounter: its medicines as one order,
 * and its printed `RX-` document, issued now. Refused, writing nothing, for a
 * drug the patient is recorded as allergic to without a reason, a child
 * without today's weight, or a controlled drug from a nurse.
 */
export async function prescribe(
  tx: AppDb,
  facilityId: string,
  encounterId: string,
  input: { indication?: string; items: MedicineInput[] },
  actor: OrderActor,
  at = new Date(),
): Promise<OrderRow> {
  const [encounter] = await tx
    .select({ status: encounters.status, patientId: encounters.patientId })
    .from(encounters)
    .where(eq(encounters.id, encounterId))
    .for("update")
    .limit(1);
  if (!encounter)
    throw new PrescriptionError("encounter_not_found");
  if (encounter.status !== "open")
    throw new PrescriptionError("not_open");
  if (new Set(input.items.map(i => i.drugCode)).size !== input.items.length)
    throw new PrescriptionError("duplicate_drug");

  const drugs: Drug[] = [];
  for (const item of input.items) {
    const drug = await currentDrug(tx, item.drugCode);
    if (!drug)
      throw new PrescriptionError("drug_not_found");
    drugs.push(drug);
  }
  if (drugs.some(d => d.controlledSchedule) && !actor.roles.some(r => CONTROLLED_PRESCRIBERS.includes(r)))
    throw new PrescriptionError("controlled_prescriber");

  // Shared, so an allergy recorded meanwhile waits for this prescription (allergies lock the patient).
  const [patient] = await tx.select({ dateOfBirth: patients.dateOfBirth }).from(patients).where(eq(patients.id, encounter.patientId)).for("share").limit(1);
  const today = businessDate(at);
  const child = ageInYears(patient.dateOfBirth, today) < CHILD_UNDER_YEARS;
  const weight = child ? await weightOn(tx, encounter.patientId, today) : null;
  if (child && !weight)
    throw new PrescriptionError("weight_needed");

  const matches = await allergyMatches(tx, encounter.patientId, drugs);
  const unexplained = input.items.flatMap(i => (i.allergyOverride ? [] : matches.get(i.drugCode) ?? []));
  if (unexplained.length > 0)
    throw new PrescriptionError("drug_allergy", unexplained);

  const lines: Line[] = input.items.map((item, i) => ({
    drug: drugs[i],
    input: item,
    route: item.route ?? drugs[i].route,
    quantity: quantityOf(item),
    overridden: matches.get(item.drugCode) ?? [],
  }));
  const indication = input.indication ?? null;
  const document = await issueDocument(tx, {
    facilityId,
    kind: "prescription",
    content: await printedPrescription(tx, encounter.patientId, lines, { indication, weight, today }, actor),
    issuedBy: actor,
    at,
  });

  const [order] = await tx.insert(orders).values({
    facilityId,
    encounterId,
    urgency: "routine",
    indication,
    orderedBy: actor.membershipId,
    enteredBy: actor.membershipId,
    orderedAt: at,
    documentId: document.id,
  }).returning();
  await tx.insert(orderItems).values(lines.map(l => ({
    facilityId,
    orderId: order.id,
    drugCode: l.drug.code,
    drugDescription: describeDrug(l.drug),
    doseAmount: l.input.doseAmount,
    doseUnit: l.drug.doseUnit,
    route: l.route,
    frequency: l.input.frequency,
    durationDays: l.input.durationDays ?? null,
    quantity: l.quantity,
    instructions: l.input.instructions ?? null,
    allergyOverrideReason: l.overridden.length > 0 ? l.input.allergyOverride! : null,
    status: "ordered" as const,
  })));

  const codes = lines.map(l => l.drug.code);
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "prescription.issued",
    entityType: "encounter",
    entityId: encounterId,
    summary: `Prescribed ${codes.join(", ")} (${document.number})`,
    detail: { orderId: order.id, number: document.number, drugs: codes, controlled: lines.filter(l => l.drug.controlledSchedule).map(l => l.drug.code) },
  });
  for (const line of lines.filter(l => l.overridden.length > 0)) {
    await recordAudit(tx, {
      facilityId,
      actorId: actor.userId,
      action: "prescription.allergy_overridden",
      entityType: "encounter",
      entityId: encounterId,
      summary: `Prescribed ${line.drug.code} despite a recorded allergy`,
      detail: { orderId: order.id, drugCode: line.drug.code, allergens: line.overridden.map(o => o.allergen), reason: line.input.allergyOverride },
    });
  }
  return order;
}

/**
 * Cancels what is left of a prescription, for a stated reason, and voids its
 * paper (it keeps its number, and the verify page says it was withdrawn): a
 * prescription is changed by cancelling it and writing a new one.
 */
export async function cancelPrescription(tx: AppDb, facilityId: string, orderId: string, reason: string, actor: PatientActor, at = new Date()): Promise<OrderRow> {
  const [found] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!found?.documentId)
    throw new PrescriptionError("not_found");
  await tx.select({ id: encounters.id }).from(encounters).where(eq(encounters.id, found.encounterId)).for("update");

  const cancelled = await tx.update(orderItems)
    .set({ status: "cancelled", cancelledAt: at, cancelledBy: actor.membershipId, cancellationReason: reason })
    .where(and(eq(orderItems.orderId, orderId), eq(orderItems.status, "ordered")))
    .returning({ drugCode: orderItems.drugCode });
  if (cancelled.length === 0)
    throw new PrescriptionError("already_cancelled");
  const document = await voidDocument(tx, { facilityId, documentId: found.documentId, reason, voidedBy: actor, at });

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "prescription.cancelled",
    entityType: "encounter",
    entityId: found.encounterId,
    summary: `Cancelled prescription ${document.number}: ${reason}`,
    detail: { orderId, number: document.number, drugs: cancelled.map(c => c.drugCode), reason },
  });
  return found;
}
