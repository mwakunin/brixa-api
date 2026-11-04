import { and, asc, count, eq, isNotNull, isNull, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { admissions, beds, bedStays, billableItems, charges, encounters, jobFailures, wards } from "@/db/schema";

import type { PatientActor } from "./patients";

import { recordAudit } from "./audit";
import { assignedByCharge } from "./billing";
import { addDays, businessDate, startOfBusinessDay } from "./dates";
import { chargeAmountCents } from "./money";
import { cashPriceList, resolvePrice } from "./prices";

/**
 * Charges (SCHEMA.md §7.2): what the hospital did, at the price of the day.
 *
 * In P2 a charge comes from a bed-day or a manual posting. Every charge is
 * priced by `resolvePrice` from the cash list, which prices the patient
 * account; P4's billing plan routes covered items to a payer's list. Callers
 * hold the encounter's lock first (lock order M8).
 */

type ChargeRow = typeof charges.$inferSelect;

export class ChargeError extends Error {
  constructor(readonly code:
    | "encounter_not_found"
    | "encounter_cancelled"
    | "item_not_found"
    | "item_inactive"
    | "not_covered"
    | "service_date_invalid"
    | "charge_not_found"
    | "already_cancelled"
    | "on_invoice") {
    super({
      encounter_not_found: "No such encounter",
      encounter_cancelled: "Charges cannot be posted to a cancelled encounter",
      item_not_found: "No such item",
      item_inactive: "That item is retired",
      not_covered: "That item has no cash price for the service date",
      service_date_invalid: "The service date must fall within the encounter and not be in the future",
      charge_not_found: "No such charge",
      already_cancelled: "This charge is already cancelled",
      on_invoice: "This charge is on an invoice; void the invoice first",
    }[code]);
    this.name = "ChargeError";
  }
}

// ---------------------------------------------------------------------------
// Manual postings
// ---------------------------------------------------------------------------

/**
 * Posts a charge by hand, for work no module captures yet (a consultation
 * before P3) or one it missed. Needs a reason, and is audited (rule 16).
 */
export async function postManualCharge(
  tx: AppDb,
  facilityId: string,
  input: { encounterId: string; billableItemId: string; quantity: string; reason: string; serviceDate?: string },
  actor: PatientActor,
): Promise<ChargeRow> {
  const [encounter] = await tx.select().from(encounters).where(eq(encounters.id, input.encounterId)).for("update").limit(1);
  if (!encounter)
    throw new ChargeError("encounter_not_found");
  if (encounter.status === "cancelled")
    throw new ChargeError("encounter_cancelled");

  const today = businessDate();
  const serviceDate = input.serviceDate ?? today;
  if (serviceDate < businessDate(encounter.startedAt) || serviceDate > today)
    throw new ChargeError("service_date_invalid");

  const [item] = await tx.select().from(billableItems).where(eq(billableItems.id, input.billableItemId)).limit(1);
  if (!item)
    throw new ChargeError("item_not_found");
  if (!item.isActive)
    throw new ChargeError("item_inactive");

  const price = await resolvePrice(tx, { billableItemId: item.id, priceListId: await cashPriceList(tx), serviceDate });
  if (!price)
    throw new ChargeError("not_covered");

  const [charge] = await tx.insert(charges).values({
    facilityId,
    encounterId: encounter.id,
    billableItemId: item.id,
    quantity: input.quantity,
    unitPriceCents: price.unitPriceCents,
    amountCents: chargeAmountCents(input.quantity, price.unitPriceCents),
    priceListItemId: price.priceListItemId,
    serviceDate,
    manualReason: input.reason,
    capturedBy: actor.membershipId,
  }).returning();

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "charge.posted",
    entityType: "charge",
    entityId: charge.id,
    summary: `Posted ${input.quantity} × ${item.code} by hand`,
    detail: { encounterId: encounter.id, code: item.code, amountCents: charge.amountCents, reason: input.reason },
  });
  return charge;
}

/**
 * Cancels a charge, for a stated reason, while no live invoice asks for it
 * (M4). One on a bill is released by voiding that bill first.
 */
export async function cancelCharge(tx: AppDb, facilityId: string, chargeId: string, reason: string, actor: PatientActor) {
  const [found] = await tx.select({ encounterId: charges.encounterId }).from(charges).where(eq(charges.id, chargeId)).limit(1);
  if (!found)
    throw new ChargeError("charge_not_found");
  // Lock order M8: the encounter, then the charge.
  await tx.select({ id: encounters.id }).from(encounters).where(eq(encounters.id, found.encounterId)).for("update");
  const [charge] = await tx.select().from(charges).where(eq(charges.id, chargeId)).for("update").limit(1);
  if (charge.cancelledAt)
    throw new ChargeError("already_cancelled");
  if ((await assignedByCharge(tx, [chargeId])).has(chargeId))
    throw new ChargeError("on_invoice");

  const [cancelled] = await tx.update(charges)
    .set({ cancelledAt: new Date(), cancelledBy: actor.membershipId, cancellationReason: reason })
    .where(eq(charges.id, chargeId))
    .returning();

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "charge.cancelled",
    entityType: "charge",
    entityId: chargeId,
    summary: `Cancelled a charge: ${reason}`,
    detail: { encounterId: charge.encounterId, amountCents: charge.amountCents, reason },
  });
  return cancelled;
}

/** An encounter's charges, oldest first, with each item's code and name. */
export async function listCharges(tx: AppDb, encounterId: string) {
  return tx
    .select({
      id: charges.id,
      code: billableItems.code,
      name: billableItems.name,
      category: billableItems.category,
      quantity: charges.quantity,
      unitPriceCents: charges.unitPriceCents,
      amountCents: charges.amountCents,
      serviceDate: charges.serviceDate,
      bedDay: sql<boolean>`${charges.bedStayId} IS NOT NULL`,
      manualReason: charges.manualReason,
      capturedAt: charges.capturedAt,
      cancelledAt: charges.cancelledAt,
      cancellationReason: charges.cancellationReason,
    })
    .from(charges)
    .innerJoin(billableItems, eq(billableItems.id, charges.billableItemId))
    .where(eq(charges.encounterId, encounterId))
    .orderBy(asc(charges.serviceDate), asc(charges.capturedAt));
}

/** How many charges on the encounter still stand. */
export async function liveChargeCount(tx: AppDb, encounterId: string): Promise<number> {
  const [row] = await tx.select({ n: count() }).from(charges).where(and(eq(charges.encounterId, encounterId), isNull(charges.cancelledAt)));
  return row.n;
}

// ---------------------------------------------------------------------------
// Bed-days
// ---------------------------------------------------------------------------

interface Night {
  serviceDate: string;
  bedStayId: string;
  wardName: string;
  bedDayItemId: string | null;
}

/**
 * The nights an admission is charged for, by the midnight rule (decided
 * 2026-11-04): one bed-day for each Nairobi midnight the patient is in a
 * bed, at the rate of the ward they are in at that midnight, dated the day
 * the night began. A stay that ended before its first midnight is one day.
 */
function nightsOf(
  admittedAt: Date,
  until: Date,
  ended: boolean,
  stays: { id: string; startedAt: Date; endedAt: Date | null; wardName: string; bedDayItemId: string | null }[],
): Night[] {
  const nights: Night[] = [];
  const last = businessDate(until);

  for (let day = addDays(businessDate(admittedAt), 1); day <= last; day = addDays(day, 1)) {
    const midnight = startOfBusinessDay(day);
    if (midnight >= until)
      break;
    const stay = stays.find(s => s.startedAt <= midnight && (s.endedAt === null || midnight < s.endedAt));
    if (stay)
      nights.push({ serviceDate: addDays(day, -1), bedStayId: stay.id, wardName: stay.wardName, bedDayItemId: stay.bedDayItemId });
  }

  if (nights.length === 0 && ended && stays.length > 0) {
    const first = stays[0];
    nights.push({ serviceDate: businessDate(admittedAt), bedStayId: first.id, wardName: first.wardName, bedDayItemId: first.bedDayItemId });
  }
  return nights;
}

/**
 * Charges every bed-day the admission has run up to `now` (or its end) and
 * not yet been charged for. Idempotent: a unique index allows one bed-day per
 * night, so a second run, or two at once, adds nothing (SCHEMA.md §7.2).
 *
 * A night whose ward has no bed-day item, or whose item has no price that
 * day, is not charged; it is recorded in `job_failures` for someone to fix,
 * and the next run charges it.
 */
export async function accrueBedDays(
  tx: AppDb,
  facilityId: string,
  encounterId: string,
  now = new Date(),
): Promise<{ created: string[]; missing: { serviceDate: string; error: string }[] }> {
  const none = { created: [], missing: [] };
  // The encounter's lock first, like every charge write (M8). A bill being
  // finalised holds it, so its nights are charged after it, never under it.
  const [encounter] = await tx.select().from(encounters).where(eq(encounters.id, encounterId)).for("update").limit(1);
  if (!encounter || encounter.kind !== "ipd" || encounter.status === "cancelled")
    return none;
  const [admission] = await tx.select().from(admissions).where(eq(admissions.encounterId, encounterId)).limit(1);
  if (!admission)
    return none;

  const stays = await tx
    .select({ id: bedStays.id, startedAt: bedStays.startedAt, endedAt: bedStays.endedAt, wardName: wards.name, bedDayItemId: wards.bedDayItemId })
    .from(bedStays)
    .innerJoin(beds, eq(beds.id, bedStays.bedId))
    .innerJoin(wards, eq(wards.id, beds.wardId))
    .where(eq(bedStays.admissionId, admission.id))
    .orderBy(asc(bedStays.startedAt));

  const until = encounter.endedAt && encounter.endedAt < now ? encounter.endedAt : now;
  const charged = new Set((await tx
    .select({ serviceDate: charges.serviceDate })
    .from(charges)
    .where(and(eq(charges.encounterId, encounterId), isNotNull(charges.bedStayId)))).map(r => r.serviceDate));

  const priceListId = await cashPriceList(tx);
  const created: string[] = [];
  const missing: { serviceDate: string; error: string }[] = [];

  for (const night of nightsOf(admission.admittedAt, until, encounter.endedAt !== null, stays)) {
    if (charged.has(night.serviceDate))
      continue;

    if (!night.bedDayItemId) {
      missing.push({ serviceDate: night.serviceDate, error: `Ward ${night.wardName} has no bed-day item` });
      continue;
    }
    const price = await resolvePrice(tx, { billableItemId: night.bedDayItemId, priceListId, serviceDate: night.serviceDate });
    if (!price) {
      missing.push({ serviceDate: night.serviceDate, error: `The bed-day item for ward ${night.wardName} has no cash price` });
      continue;
    }

    const inserted = await tx.insert(charges).values({
      facilityId,
      encounterId,
      billableItemId: night.bedDayItemId,
      quantity: "1",
      unitPriceCents: price.unitPriceCents,
      amountCents: chargeAmountCents("1", price.unitPriceCents),
      priceListItemId: price.priceListItemId,
      serviceDate: night.serviceDate,
      bedStayId: night.bedStayId,
    }).onConflictDoNothing({
      target: [charges.encounterId, charges.serviceDate],
      where: sql`${charges.bedStayId} IS NOT NULL`,
    }).returning({ id: charges.id });
    if (inserted.length > 0)
      created.push(night.serviceDate);
  }

  for (const gap of missing) {
    await tx.insert(jobFailures).values({
      facilityId,
      job: "bed_day_accrual",
      subjectId: encounterId,
      error: gap.error,
    }).onConflictDoNothing({
      target: [jobFailures.facilityId, jobFailures.job, jobFailures.subjectId, jobFailures.error],
      where: sql`${jobFailures.resolvedAt} IS NULL`,
    });
  }

  if (created.length > 0) {
    await recordAudit(tx, {
      facilityId,
      action: "charge.accrued",
      entityType: "encounter",
      entityId: encounterId,
      summary: `Charged ${created.length} bed-day(s) for ${admission.admissionNumber}`,
      detail: { serviceDates: created },
    });
  }

  return { created, missing };
}
