import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { billableItems, charges, dispenseLines, dispenses, documents, drugCatalogue, encounters, memberships, orderItems, orders, patientNumbers, patients, stockBatches, stockItems, stockMovements, stores, user } from "@/db/schema";

import type { PatientActor } from "./patients";
import type { WorklistPatient } from "./worklist-patient";

import { recordAudit } from "./audit";
import { DispenseError } from "./dispensing";
import { paidCharges } from "./specimens";
import { patientColumns, patientOf } from "./worklist-patient";

/** What the pharmacy sees (P4 slice 3a). Its list names patients, so viewing it is audited (rule 9). */

/** The most prescriptions the list shows at once, oldest first. */
export const WORKLIST_LIMIT = 200;

export interface WaitingMedicine {
  orderItemId: string;
  drugCode: string;
  /** As prescribed, e.g. `Paracetamol 500 mg Tablet`. */
  description: string;
  doseUnit: string;
  /** Prescribed, in the dose unit. */
  quantity: number;
  /** Handed over so far, in base units. */
  given: number;
  /** Prepared and waiting to be handed over. */
  prepared: boolean;
  controlledSchedule: string | null;
}

export interface WaitingPrescription {
  orderId: string;
  /** The prescription's `RX-` number. */
  number: string;
  encounterId: string;
  patient: WorklistPatient;
  prescribedByName: string | null;
  orderedAt: Date;
  medicines: WaitingMedicine[];
}

const visitPatient = and(eq(encounters.id, orders.encounterId), eq(encounters.status, "open"));

/** Medicines neither finished nor cancelled on open visits, by prescription, oldest first. */
async function waiting(tx: AppDb): Promise<WaitingPrescription[]> {
  const pending = and(isNotNull(orderItems.drugCode), eq(orderItems.status, "ordered"));
  // The oldest prescriptions first, a bounded number, each then read whole.
  const oldest = await tx
    .select({ id: orders.id, orderedAt: orders.orderedAt })
    .from(orders)
    .innerJoin(encounters, visitPatient)
    .where(sql`EXISTS (SELECT 1 FROM ${orderItems} WHERE ${orderItems.orderId} = ${orders.id} AND ${pending})`)
    .orderBy(asc(orders.orderedAt), asc(orders.id))
    .limit(WORKLIST_LIMIT);
  if (oldest.length === 0)
    return [];
  const rows = await tx
    .select({
      orderId: orders.id,
      number: documents.number,
      encounterId: orders.encounterId,
      orderedAt: orders.orderedAt,
      prescribedByName: user.name,
      medicine: orderItems,
      controlledSchedule: drugCatalogue.controlledSchedule,
      ...patientColumns,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(documents, eq(documents.id, orders.documentId))
    .innerJoin(encounters, visitPatient)
    .innerJoin(patients, eq(patients.id, encounters.patientId))
    .leftJoin(patientNumbers, and(eq(patientNumbers.patientId, patients.id), eq(patientNumbers.kind, "outpatient")))
    .leftJoin(memberships, eq(memberships.id, orders.orderedBy))
    .leftJoin(user, eq(user.id, memberships.userId))
    .leftJoin(drugCatalogue, eq(drugCatalogue.code, orderItems.drugCode))
    .where(and(pending, inArray(orders.id, oldest.map(o => o.id))))
    .orderBy(asc(orders.orderedAt), asc(orders.id), asc(orderItems.id));

  const ids = rows.map(r => r.medicine.id);
  const lines = await tx
    .select({ orderItemId: dispenseLines.orderItemId, status: dispenses.status, quantity: dispenseLines.quantity })
    .from(dispenseLines)
    .innerJoin(dispenses, eq(dispenses.id, dispenseLines.dispenseId))
    .where(and(inArray(dispenseLines.orderItemId, ids), inArray(dispenses.status, ["prepared", "handed_over"])));
  const given = new Map<string, number>();
  const prepared = new Set<string>();
  for (const l of lines) {
    if (l.status === "prepared")
      prepared.add(l.orderItemId);
    else
      given.set(l.orderItemId, (given.get(l.orderItemId) ?? 0) + l.quantity);
  }

  const byOrder = new Map<string, WaitingPrescription>();
  for (const r of rows) {
    const prescription = byOrder.get(r.orderId) ?? { orderId: r.orderId, number: r.number, encounterId: r.encounterId, patient: patientOf(r), prescribedByName: r.prescribedByName, orderedAt: r.orderedAt, medicines: [] };
    prescription.medicines.push({
      orderItemId: r.medicine.id,
      drugCode: r.medicine.drugCode!,
      description: r.medicine.drugDescription!,
      doseUnit: r.medicine.doseUnit!,
      quantity: Number(r.medicine.quantity),
      given: given.get(r.medicine.id) ?? 0,
      prepared: prepared.has(r.medicine.id),
      controlledSchedule: r.controlledSchedule,
    });
    byOrder.set(r.orderId, prescription);
  }
  return [...byOrder.values()];
}

/**
 * The pharmacy's list: prescriptions with a medicine still to give, and
 * dispenses prepared and not yet collected. Audited, as it names patients.
 */
export async function pharmacyWorklist(tx: AppDb, facilityId: string, actor: PatientActor): Promise<{ waiting: WaitingPrescription[]; prepared: ShownDispense[] }> {
  const list = await waiting(tx);
  const preparedIds = await tx.select({ id: dispenses.id }).from(dispenses).where(eq(dispenses.status, "prepared")).orderBy(asc(dispenses.preparedAt)).limit(WORKLIST_LIMIT);
  const prepared = await dispensesShown(tx, preparedIds.map(d => d.id));
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "pharmacy.worklist_viewed",
    entityType: "facility",
    entityId: facilityId,
    summary: `Viewed the pharmacy's list (${list.length} prescriptions waiting, ${prepared.length} prepared)`,
  });
  return { waiting: list, prepared };
}

interface Step { byName: string; at: Date }

export interface ShownDispenseLine {
  /** What a patient's return names. */
  id: string;
  orderItemId: string;
  description: string;
  stockItemId: string;
  code: string;
  name: string;
  baseUnit: string;
  quantity: number;
  completes: boolean;
  amountCents: number;
  /** Where it was taken from; given back if the dispense was cancelled. */
  batches: { batchId: string; batchNumber: string | null; expiresOn: string | null; quantity: number }[];
}

export interface ShownDispense {
  id: string;
  status: (typeof dispenses.$inferSelect)["status"];
  orderId: string;
  /** The prescription's `RX-` number. */
  number: string;
  encounterId: string;
  patient: WorklistPatient;
  store: { id: string; name: string };
  prepared: Step;
  handedOver: Step | null;
  cancelled: (Step & { reason: string }) | null;
  /** An outpatient's medicines not yet paid for: a warning at the hand-over, never a block. */
  unpaid: boolean;
  lines: ShownDispenseLine[];
}

async function namesOf(tx: AppDb, ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0)
    return new Map();
  const rows = await tx.select({ id: memberships.id, name: user.name }).from(memberships).innerJoin(user, eq(user.id, memberships.userId)).where(inArray(memberships.id, wanted));
  return new Map(rows.map(r => [r.id, r.name]));
}

/**
 * Each line's charge as the dispense shows it: the standing one, which a
 * return may have replaced; for a cancelled dispense, the last it had.
 */
async function lineCharges(tx: AppDb, lineIds: string[]): Promise<Map<string, { id: string; amountCents: number }>> {
  if (lineIds.length === 0)
    return new Map();
  const rows = await tx
    .select({ id: charges.id, lineId: charges.dispenseLineId, amountCents: charges.amountCents, cancelledAt: charges.cancelledAt })
    .from(charges)
    .where(inArray(charges.dispenseLineId, lineIds))
    .orderBy(asc(charges.capturedAt), asc(charges.id));
  const chosen = new Map<string, { id: string; amountCents: number; standing: boolean }>();
  for (const r of rows) {
    const standing = r.cancelledAt === null;
    // A standing charge wins; else the latest.
    if (!chosen.get(r.lineId!)?.standing || standing)
      chosen.set(r.lineId!, { id: r.id, amountCents: r.amountCents, standing });
  }
  return chosen;
}

async function linesOf(tx: AppDb, dispenseIds: string[]): Promise<Map<string, (ShownDispenseLine & { chargeId: string | null })[]>> {
  const rows = await tx
    .select({ line: dispenseLines, description: orderItems.drugDescription, code: billableItems.code, name: billableItems.name, baseUnit: stockItems.baseUnit })
    .from(dispenseLines)
    .innerJoin(orderItems, eq(orderItems.id, dispenseLines.orderItemId))
    .innerJoin(stockItems, eq(stockItems.id, dispenseLines.stockItemId))
    .innerJoin(billableItems, eq(billableItems.id, stockItems.billableItemId))
    .where(inArray(dispenseLines.dispenseId, dispenseIds))
    .orderBy(asc(billableItems.code));
  const chargeOf = await lineCharges(tx, rows.map(r => r.line.id));
  const taken = rows.length === 0
    ? []
    : await tx
        .select({ lineId: stockMovements.dispenseLineId, batchId: stockBatches.id, batchNumber: stockBatches.batchNumber, expiresOn: stockBatches.expiresOn, quantity: sql<number>`-${stockMovements.quantity}` })
        .from(stockMovements)
        .innerJoin(stockBatches, eq(stockBatches.id, stockMovements.batchId))
        .where(and(inArray(stockMovements.dispenseLineId, rows.map(r => r.line.id)), eq(stockMovements.kind, "dispense")))
        .orderBy(sql`${stockBatches.expiresOn} ASC NULLS LAST`);
  const batchesOf = Map.groupBy(taken, t => t.lineId!);
  const result = new Map<string, (ShownDispenseLine & { chargeId: string | null })[]>();
  for (const r of rows) {
    const shown = {
      id: r.line.id,
      orderItemId: r.line.orderItemId,
      description: r.description!,
      stockItemId: r.line.stockItemId,
      code: r.code,
      name: r.name,
      baseUnit: r.baseUnit,
      quantity: r.line.quantity,
      completes: r.line.completes,
      amountCents: chargeOf.get(r.line.id)?.amountCents ?? 0,
      chargeId: chargeOf.get(r.line.id)?.id ?? null,
      batches: (batchesOf.get(r.line.id) ?? []).map(b => ({ batchId: b.batchId, batchNumber: b.batchNumber, expiresOn: b.expiresOn, quantity: Number(b.quantity) })),
    };
    result.set(r.line.dispenseId, [...(result.get(r.line.dispenseId) ?? []), shown]);
  }
  return result;
}

/** These dispenses, in the order given. */
async function dispensesShown(tx: AppDb, ids: string[]): Promise<ShownDispense[]> {
  if (ids.length === 0)
    return [];
  const rows = await tx
    .select({ dispense: dispenses, number: documents.number, storeName: stores.name, kind: encounters.kind, ...patientColumns })
    .from(dispenses)
    .innerJoin(orders, eq(orders.id, dispenses.orderId))
    .innerJoin(documents, eq(documents.id, orders.documentId))
    .innerJoin(stores, eq(stores.id, dispenses.storeId))
    .innerJoin(encounters, eq(encounters.id, dispenses.encounterId))
    .innerJoin(patients, eq(patients.id, encounters.patientId))
    .leftJoin(patientNumbers, and(eq(patientNumbers.patientId, patients.id), eq(patientNumbers.kind, "outpatient")))
    .where(inArray(dispenses.id, ids));
  const names = await namesOf(tx, rows.flatMap(r => [r.dispense.preparedBy, r.dispense.handedOverBy, r.dispense.cancelledBy]));
  const lines = await linesOf(tx, ids);
  const charged = [...lines.values()].flat().filter(l => l.chargeId && l.amountCents > 0).map(l => l.chargeId!);
  const paid = await paidCharges(tx, charged);
  const step = (by: string | null, at: Date | null): Step | null => (by && at ? { byName: names.get(by) ?? "", at } : null);

  const byId = new Map(rows.map((r) => {
    const d = r.dispense;
    const own = lines.get(d.id) ?? [];
    const cancelled = step(d.cancelledBy, d.cancelledAt);
    return [d.id, {
      id: d.id,
      status: d.status,
      orderId: d.orderId,
      number: r.number,
      encounterId: d.encounterId,
      patient: patientOf(r),
      store: { id: d.storeId, name: r.storeName },
      prepared: step(d.preparedBy, d.preparedAt)!,
      handedOver: step(d.handedOverBy, d.handedOverAt),
      cancelled: cancelled && { ...cancelled, reason: d.cancellationReason! },
      // An emergency or an admission is never held up over money, as at the lab.
      unpaid: r.kind === "opd" && d.status !== "cancelled" && own.some(l => l.chargeId && l.amountCents > 0 && !paid.has(l.chargeId)),
      lines: own.map(({ chargeId: _, ...l }) => l),
    } satisfies ShownDispense];
  }));
  return ids.flatMap(id => byId.get(id) ?? []);
}

/** One dispense as the pharmacy sees it. Not audited: for answering a write, which is. */
export async function dispenseShown(tx: AppDb, id: string): Promise<ShownDispense> {
  const [shown] = await dispensesShown(tx, [id]);
  if (!shown)
    throw new DispenseError("not_found");
  return shown;
}

/** One dispense opened on its own: it names its patient and medicines, so the read is audited (rule 9). */
export async function viewDispense(tx: AppDb, facilityId: string, id: string, actor: PatientActor): Promise<ShownDispense> {
  const shown = await dispenseShown(tx, id);
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "dispense.viewed",
    entityType: "encounter",
    entityId: shown.encounterId,
    summary: "Viewed a dispense",
    detail: { dispenseId: id },
  });
  return shown;
}
