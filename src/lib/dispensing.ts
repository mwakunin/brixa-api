import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { AppDb } from "@/db";
import type { MembershipRole } from "@/db/schema";

import { billableItems, dispenseLines, dispenses, drugCatalogue, encounters, medicinesNotSupplied, orderItems, orders, stockBatches, stockItems, stockMovements, stores } from "@/db/schema";

import type { PatientActor } from "./patients";
import type { Taken } from "./stock-allocation";

import { recordAudit } from "./audit";
import { assignedByCharge } from "./billing";
import { cancelDispenseCharges, captureDispenseCharge, dispenseCharges } from "./charges";
import { businessDate } from "./dates";
import { chargeAmountCents } from "./money";
import { cashPriceList, resolvePrice } from "./prices";
import { allocate } from "./stock-allocation";

/**
 * Dispensing (SCHEMA.md §8, P4 slice 3a, decided 2026-11-15): a
 * prescription prepared from a pharmacy's stock, earliest expiry first,
 * which takes the stock and raises a charge per medicine; then handed over,
 * which finishes the medicines it completes. A medicine the pharmacy does
 * not supply is marked so, with a reason, which ends it without a charge.
 *
 * Lock order: the encounter (M8), the dispense, its medicines, then the
 * store's items and batches (lib/stock-levels.ts), then its charges.
 */

type DispenseRow = typeof dispenses.$inferSelect;
type MedicineRow = typeof orderItems.$inferSelect;

/** Who prepares and hands over, under a current licence. */
export const DISPENSERS = ["pharmacist", "pharm_tech"] as const satisfies readonly MembershipRole[];

/** A dispenser, with what decides whether they may give a controlled drug. */
export interface DispenseActor extends PatientActor {
  roles: readonly MembershipRole[];
  licenceProfession: string | null;
}

export type DispenseErrorCode
  = | "not_found"
    | "prescription_not_found"
    | "visit_closed"
    | "store_needed"
    | "not_a_pharmacy"
    | "medicine_not_found"
    | "medicine_finished"
    | "already_prepared"
    | "wrong_drug"
    | "item_retired"
    | "quantity_needed"
    | "more_than_owed"
    | "not_priced"
    | "amount_too_large"
    | "batch_expired"
    | "controlled_dispenser"
    | "not_prepared"
    | "billed";

export class DispenseError extends Error {
  constructor(readonly code: DispenseErrorCode, readonly line?: number) {
    super(`${line === undefined ? "" : `Line ${line}: `}${{
      not_found: "No such dispense",
      prescription_not_found: "No such prescription",
      visit_closed: "This visit is closed; its medicines are no longer dispensed",
      store_needed: "Name the pharmacy to dispense from",
      not_a_pharmacy: "That is not an open pharmacy of this facility",
      medicine_not_found: "That is not a medicine on this prescription",
      medicine_finished: "That medicine has been dispensed, marked not supplied, or cancelled",
      already_prepared: "That medicine is already prepared and waiting to be handed over",
      wrong_drug: "That stock item is not the drug prescribed",
      item_retired: "That stock item is retired",
      quantity_needed: "The item is counted in another unit than the prescription: give the quantity",
      more_than_owed: "More than is still to be given",
      not_priced: "That item has no price; the finance manager prices it before it is dispensed",
      amount_too_large: "One line's charge would exceed KES 20 million; split it",
      batch_expired: "A batch this dispense was prepared from has expired since: cancel it, which puts the stock back, and prepare it again",
      controlled_dispenser: "A controlled drug is dispensed by a pharmacist with a pharmacy licence",
      not_prepared: "This dispense has been handed over or cancelled",
      billed: "A charge of this dispense is on a bill; take the medicines back as a return instead",
    }[code]}`);
    this.name = "DispenseError";
  }
}

export interface PrepareLine {
  /** The medicine on the prescription. */
  orderItemId: string;
  stockItemId: string;
  /** In the item's base unit; defaults to what is owed where the units match. */
  quantity?: number;
  /** The batches to take it from, instead of earliest expiry first. */
  batches?: { batchId: string; quantity: number }[];
  /** In units other than the prescription's: whether this finishes the medicine (it does unless said). */
  complete?: boolean;
}

/** Whether this member may give, take back or adjust a controlled drug: a pharmacist under a pharmacy licence. */
export function mayGiveControlled(actor: DispenseActor): boolean {
  return actor.roles.includes("pharmacist") && actor.licenceProfession === "pharmacy";
}

/** Locks the encounter (M8) and refuses a closed visit. */
async function lockOpenVisit(tx: AppDb, encounterId: string): Promise<{ kind: string }> {
  const [visit] = await tx.select({ status: encounters.status, kind: encounters.kind }).from(encounters).where(eq(encounters.id, encounterId)).for("update");
  if (visit.status !== "open")
    throw new DispenseError("visit_closed");
  return visit;
}

/** The pharmacy named, or the facility's only one. */
async function pharmacyOf(tx: AppDb, storeId: string | undefined): Promise<string> {
  const open = await tx.select({ id: stores.id }).from(stores).where(and(eq(stores.kind, "pharmacy"), eq(stores.isActive, true), storeId ? eq(stores.id, storeId) : undefined)).for("share");
  if (storeId && open.length === 0)
    throw new DispenseError("not_a_pharmacy");
  if (open.length !== 1)
    throw new DispenseError("store_needed");
  return open[0].id;
}

/** Medicines on one prepared dispense or another, of these. */
async function beingPrepared(tx: AppDb, orderItemIds: string[]): Promise<Set<string>> {
  const rows = await tx.select({ id: dispenseLines.orderItemId }).from(dispenseLines).innerJoin(dispenses, eq(dispenses.id, dispenseLines.dispenseId)).where(and(eq(dispenses.status, "prepared"), inArray(dispenseLines.orderItemId, orderItemIds)));
  return new Set(rows.map(r => r.id));
}

/** What a medicine has been given so far. */
interface Given {
  /** In base units, every line counted. */
  total: number;
  /** Of that, in stock counted in the prescription's own dose unit. */
  inDoseUnit: number;
  /** Some was given in another unit, which cannot be counted against the prescription. */
  otherUnits: boolean;
}

/** What has been handed over of each medicine, by whether its unit is the prescription's. */
async function handedOverOf(tx: AppDb, orderItemIds: string[]): Promise<Map<string, Given>> {
  const sameUnit = sql`lower(${stockItems.baseUnit}) = lower(${orderItems.doseUnit})`;
  const rows = await tx
    .select({
      id: dispenseLines.orderItemId,
      total: sql<string>`sum(${dispenseLines.quantity})`,
      inDoseUnit: sql<string>`coalesce(sum(${dispenseLines.quantity}) FILTER (WHERE ${sameUnit}), 0)`,
      otherUnits: sql<boolean>`bool_or(NOT ${sameUnit})`,
    })
    .from(dispenseLines)
    .innerJoin(dispenses, eq(dispenses.id, dispenseLines.dispenseId))
    .innerJoin(stockItems, eq(stockItems.id, dispenseLines.stockItemId))
    .innerJoin(orderItems, eq(orderItems.id, dispenseLines.orderItemId))
    .where(and(eq(dispenses.status, "handed_over"), inArray(dispenseLines.orderItemId, orderItemIds)))
    .groupBy(dispenseLines.orderItemId);
  return new Map(rows.map(r => [r.id, { total: Number(r.total), inDoseUnit: Number(r.inDoseUnit), otherUnits: Boolean(r.otherUnits) }]));
}

interface PlannedLine {
  line: PrepareLine;
  medicine: MedicineRow;
  item: { id: string; billableItemId: string; code: string };
  quantity: number;
  completes: boolean;
}

/** How much a line gives, and whether that finishes its medicine (P4 slice 3a, questions 4 and 5). */
function quantityOf(line: PrepareLine, number: number, medicine: MedicineRow, baseUnit: string, givenSoFar: Given | undefined): { quantity: number; completes: boolean } {
  const asked = line.batches ? line.batches.reduce((sum, b) => sum + b.quantity, 0) : line.quantity;
  // Some given in another unit cannot be subtracted from the prescription: the pharmacist says how much, and whether it finishes it.
  if (baseUnit.toLowerCase() !== (medicine.doseUnit ?? "").toLowerCase() || givenSoFar?.otherUnits) {
    if (asked === undefined)
      throw new DispenseError("quantity_needed", number);
    return { quantity: asked, completes: line.complete ?? true };
  }
  const prescribed = Number(medicine.quantity);
  const given = givenSoFar?.inDoseUnit ?? 0;
  const owed = Math.ceil(prescribed - given);
  const quantity = asked ?? owed;
  if (quantity > owed || quantity < 1)
    throw new DispenseError("more_than_owed", number);
  return { quantity, completes: given + quantity >= prescribed };
}

async function planLines(tx: AppDb, orderId: string, lines: PrepareLine[], actor: DispenseActor): Promise<PlannedLine[]> {
  const ids = lines.map(l => l.orderItemId.toLowerCase());
  const medicines = await tx.select().from(orderItems).where(and(eq(orderItems.orderId, orderId), inArray(orderItems.id, ids))).orderBy(asc(orderItems.id)).for("update");
  const medicineOf = new Map(medicines.map(m => [m.id, m]));
  const preparing = await beingPrepared(tx, ids);
  const given = await handedOverOf(tx, ids);
  const items = await tx
    .select({ id: stockItems.id, billableItemId: stockItems.billableItemId, drugCode: stockItems.drugCode, baseUnit: stockItems.baseUnit, isActive: stockItems.isActive, schedule: drugCatalogue.controlledSchedule, code: billableItems.code })
    .from(stockItems)
    .innerJoin(billableItems, eq(billableItems.id, stockItems.billableItemId))
    .leftJoin(drugCatalogue, eq(drugCatalogue.code, stockItems.drugCode))
    .where(inArray(stockItems.id, lines.map(l => l.stockItemId.toLowerCase())));
  const itemOf = new Map(items.map(i => [i.id, i]));

  return lines.map((line, index) => {
    const number = index + 1;
    const medicine = medicineOf.get(line.orderItemId.toLowerCase());
    if (!medicine?.drugCode)
      throw new DispenseError("medicine_not_found", number);
    if (medicine.status !== "ordered")
      throw new DispenseError("medicine_finished", number);
    if (preparing.has(medicine.id))
      throw new DispenseError("already_prepared", number);
    const item = itemOf.get(line.stockItemId.toLowerCase());
    if (!item || item.drugCode !== medicine.drugCode)
      throw new DispenseError("wrong_drug", number);
    if (!item.isActive)
      throw new DispenseError("item_retired", number);
    // A controlled drug: a pharmacist, under a pharmacy licence (P4 question 4).
    if (item.schedule && !mayGiveControlled(actor))
      throw new DispenseError("controlled_dispenser", number);
    return { line, medicine, item, ...quantityOf(line, number, medicine, item.baseUnit, given.get(medicine.id)) };
  });
}

/**
 * Prepares a prescription from a pharmacy: takes each medicine's stock,
 * earliest expiry first unless batches are named, and charges it. A
 * refused line refuses the whole dispense, and nothing of it is kept.
 */
export async function prepareDispense(
  tx: AppDb,
  facilityId: string,
  input: { orderId: string; storeId?: string; lines: PrepareLine[] },
  actor: DispenseActor,
  at = new Date(),
): Promise<DispenseRow> {
  const [order] = await tx.select({ id: orders.id, encounterId: orders.encounterId, documentId: orders.documentId }).from(orders).where(eq(orders.id, input.orderId)).limit(1);
  if (!order?.documentId)
    throw new DispenseError("prescription_not_found");
  await lockOpenVisit(tx, order.encounterId);
  const planned = await planLines(tx, order.id, input.lines, actor);
  const storeId = await pharmacyOf(tx, input.storeId);

  const serviceDate = businessDate(at);
  const listId = await cashPriceList(tx);
  const prices = [];
  for (const [index, p] of planned.entries()) {
    const price = await resolvePrice(tx, { billableItemId: p.item.billableItemId, priceListId: listId, serviceDate });
    if (!price)
      throw new DispenseError("not_priced", index + 1);
    // Checked before anything is taken: one charge holds at most KES 20 million, and rounding refuses more.
    try {
      chargeAmountCents(String(p.quantity), price.unitPriceCents);
    }
    catch (err) {
      if (err instanceof RangeError)
        throw new DispenseError("amount_too_large", index + 1);
      throw err;
    }
    prices.push(price);
  }
  const taken = await allocate(tx, facilityId, storeId, planned.map(p => ({ stockItemId: p.item.id, quantity: p.line.batches ? undefined : p.quantity, batches: p.line.batches })), serviceDate);

  const [dispense] = await tx.insert(dispenses).values({ facilityId, encounterId: order.encounterId, orderId: order.id, storeId, status: "prepared", preparedBy: actor.membershipId, preparedAt: at }).returning();
  for (const [index, p] of planned.entries())
    await writeLine(tx, facilityId, dispense, p, taken[index], prices[index], serviceDate, actor);

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "dispense.prepared",
    entityType: "encounter",
    entityId: order.encounterId,
    summary: `Prepared ${planned.length} medicine${planned.length === 1 ? "" : "s"} for dispensing`,
    detail: { dispenseId: dispense.id, orderId: order.id, storeId, lines: planned.map(p => ({ orderItemId: p.medicine.id, stockItemId: p.item.id, quantity: p.quantity })) },
  });
  return dispense;
}

async function writeLine(tx: AppDb, facilityId: string, dispense: DispenseRow, p: PlannedLine, taken: Taken[], price: { priceListItemId: string; unitPriceCents: number }, serviceDate: string, actor: DispenseActor): Promise<void> {
  const [line] = await tx.insert(dispenseLines).values({ facilityId, dispenseId: dispense.id, orderItemId: p.medicine.id, stockItemId: p.item.id, quantity: p.quantity, completes: p.completes }).returning({ id: dispenseLines.id });
  await tx.insert(stockMovements).values(taken.map(t => ({
    facilityId,
    storeId: dispense.storeId,
    batchId: t.batchId,
    kind: "dispense" as const,
    quantity: -t.quantity,
    dispenseLineId: line.id,
    recordedBy: actor.membershipId,
  })));
  await captureDispenseCharge(tx, facilityId, { encounterId: dispense.encounterId, dispenseLineId: line.id, billableItemId: p.item.billableItemId, code: p.item.code, quantity: p.quantity, price, serviceDate }, actor);
}

async function lockDispense(tx: AppDb, id: string): Promise<DispenseRow> {
  const [found] = await tx.select({ encounterId: dispenses.encounterId }).from(dispenses).where(eq(dispenses.id, id)).limit(1);
  if (!found)
    throw new DispenseError("not_found");
  await tx.select({ id: encounters.id }).from(encounters).where(eq(encounters.id, found.encounterId)).for("update");
  const [dispense] = await tx.select().from(dispenses).where(eq(dispenses.id, id)).for("update");
  if (dispense.status !== "prepared")
    throw new DispenseError("not_prepared");
  return dispense;
}

/**
 * Hands a prepared dispense over, finishing each medicine its lines
 * complete. Never held up over money: the response says whether it is paid.
 */
export async function handOver(tx: AppDb, facilityId: string, id: string, actor: DispenseActor, at = new Date()): Promise<DispenseRow> {
  await lockDispense(tx, id);
  const lines = await tx.select({ line: dispenseLines, schedule: drugCatalogue.controlledSchedule })
    .from(dispenseLines)
    .innerJoin(stockItems, eq(stockItems.id, dispenseLines.stockItemId))
    .leftJoin(drugCatalogue, eq(drugCatalogue.code, stockItems.drugCode))
    .where(eq(dispenseLines.dispenseId, id))
    .then(rows => rows.map(r => ({ ...r.line, schedule: r.schedule })));
  // A controlled drug is handed over, as it is prepared, by a pharmacist under a pharmacy licence (P4 question 4).
  if (lines.some(l => l.schedule) && !mayGiveControlled(actor))
    throw new DispenseError("controlled_dispenser");
  // An expired batch is never dispensed (P4 question 6), though it was in date when prepared.
  const [expired] = await tx.select({ id: stockBatches.id }).from(stockMovements).innerJoin(stockBatches, eq(stockBatches.id, stockMovements.batchId)).where(and(inArray(stockMovements.dispenseLineId, lines.map(l => l.id)), eq(stockMovements.kind, "dispense"), sql`${stockBatches.expiresOn} < ${businessDate(at)}`)).limit(1);
  if (expired)
    throw new DispenseError("batch_expired");
  const finishing = lines.filter(l => l.completes).map(l => l.orderItemId);
  if (finishing.length > 0) {
    await tx.update(orderItems)
      .set({ status: "done", doneAt: at, doneBy: actor.membershipId })
      .where(and(inArray(orderItems.id, finishing), eq(orderItems.status, "ordered")));
  }
  const [handed] = await tx.update(dispenses).set({ status: "handed_over", handedOverBy: actor.membershipId, handedOverAt: at }).where(eq(dispenses.id, id)).returning();
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "dispense.handed_over",
    entityType: "encounter",
    entityId: handed.encounterId,
    summary: `Handed over ${lines.length} medicine${lines.length === 1 ? "" : "s"}`,
    detail: { dispenseId: id, finished: finishing },
  });
  return handed;
}

/**
 * Cancels a prepared dispense not handed over: its stock goes back to the
 * batches it came from, and its charges are cancelled, while none is on a
 * bill (P4 slice 3a, question 7). Once billed, it is a return (3b).
 */
export async function cancelDispense(tx: AppDb, facilityId: string, id: string, reason: string, actor: PatientActor): Promise<DispenseRow> {
  const dispense = await lockDispense(tx, id);
  const lines = await tx.select({ id: dispenseLines.id }).from(dispenseLines).where(eq(dispenseLines.dispenseId, id));
  const lineIds = lines.map(l => l.id);
  const found = await dispenseCharges(tx, lineIds);
  if ((await assignedByCharge(tx, found.map(c => c.id))).size > 0)
    throw new DispenseError("billed");

  const takings = await tx.select().from(stockMovements).where(and(inArray(stockMovements.dispenseLineId, lineIds), eq(stockMovements.kind, "dispense")));
  await tx.insert(stockMovements).values(takings.map(m => ({
    facilityId,
    storeId: m.storeId,
    batchId: m.batchId,
    kind: "dispense_cancelled" as const,
    quantity: -m.quantity,
    dispenseLineId: m.dispenseLineId,
    recordedBy: actor.membershipId,
  })));
  await cancelDispenseCharges(tx, facilityId, found, reason, actor);
  const [cancelled] = await tx.update(dispenses).set({ status: "cancelled", cancelledBy: actor.membershipId, cancelledAt: new Date(), cancellationReason: reason }).where(eq(dispenses.id, id)).returning();
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "dispense.cancelled",
    entityType: "encounter",
    entityId: dispense.encounterId,
    summary: `Cancelled a prepared dispense: ${reason}`,
    detail: { dispenseId: id, reason },
  });
  return cancelled;
}

export type NotSuppliedReason = (typeof medicinesNotSupplied.$inferInsert)["reason"];

/**
 * Ends a medicine the pharmacy does not supply, or not the rest of, without
 * a charge for what was not given (P4 question 7), so the visit can close.
 */
export async function markNotSupplied(
  tx: AppDb,
  facilityId: string,
  orderItemId: string,
  input: { reason: NotSuppliedReason; note?: string },
  actor: PatientActor,
  at = new Date(),
): Promise<string> {
  const [found] = await tx.select({ encounterId: orders.encounterId, drugCode: orderItems.drugCode }).from(orderItems).innerJoin(orders, eq(orders.id, orderItems.orderId)).where(eq(orderItems.id, orderItemId)).limit(1);
  if (!found?.drugCode)
    throw new DispenseError("medicine_not_found");
  await lockOpenVisit(tx, found.encounterId);
  const [medicine] = await tx.select().from(orderItems).where(eq(orderItems.id, orderItemId)).for("update");
  if (medicine.status !== "ordered")
    throw new DispenseError("medicine_finished");
  if ((await beingPrepared(tx, [medicine.id])).size > 0)
    throw new DispenseError("already_prepared");

  const given = (await handedOverOf(tx, [medicine.id])).get(medicine.id)?.total ?? 0;
  await tx.insert(medicinesNotSupplied).values({ facilityId, orderItemId: medicine.id, reason: input.reason, note: input.note ?? null, recordedBy: actor.membershipId, recordedAt: at });
  await tx.update(orderItems).set({ status: "done", doneAt: at, doneBy: actor.membershipId }).where(eq(orderItems.id, medicine.id));
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "medicine.not_supplied",
    entityType: "encounter",
    entityId: found.encounterId,
    summary: given > 0 ? "Marked the rest of a medicine not supplied" : "Marked a medicine not supplied",
    detail: { orderItemId: medicine.id, drugCode: medicine.drugCode, reason: input.reason, alreadyGiven: given },
  });
  return found.encounterId;
}

/** Whether a prepared dispense of this prescription waits to be handed over or cancelled. */
export async function hasPreparedDispense(tx: AppDb, orderId: string): Promise<boolean> {
  const rows = await tx.select({ id: dispenses.id }).from(dispenses).where(and(eq(dispenses.orderId, orderId), eq(dispenses.status, "prepared"))).limit(1);
  return rows.length > 0;
}
