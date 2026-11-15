import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { billableItems, drugCatalogue, stockAdjustmentLines, stockAdjustments, stockBatches, stockItems, stockMovements, stores } from "@/db/schema";

import type { DispenseActor } from "./dispensing";
import type { PatientActor } from "./patients";

import { recordAudit } from "./audit";
import { businessDate } from "./dates";
import { lockBatches } from "./stock-levels";

/**
 * Stock adjustments (SCHEMA.md §8, P4 slice 3b, decided 2026-11-15):
 * write-offs (expired, damaged, lost), stock found, and corrections. The
 * stores' staff ask, with a reason; the finance manager or a pharmacist
 * approves, never the asker (rule 24). A batch moves only on approval.
 */

type AdjustmentRow = typeof stockAdjustments.$inferSelect;
export type StockAdjustmentKind = AdjustmentRow["kind"];
export type StockAdjustmentStatus = AdjustmentRow["status"];

export type StockAdjustmentErrorCode
  = | "not_found"
    | "store_not_found"
    | "batch_not_found"
    | "wrong_sign"
    | "not_expired"
    | "not_enough_stock"
    | "controlled_dispenser"
    | "not_pending"
    | "same_person"
    | "not_requester";

export class StockAdjustmentError extends Error {
  constructor(readonly code: StockAdjustmentErrorCode, readonly line?: number) {
    super(`${line === undefined ? "" : `Line ${line}: `}${{
      not_found: "No such stock adjustment",
      store_not_found: "No such store",
      batch_not_found: "No such batch",
      wrong_sign: "A write-off takes stock off the shelf, and stock found puts it on",
      not_expired: "That batch has not expired; write it off as damaged or lost",
      not_enough_stock: "The store does not hold that much of that batch",
      controlled_dispenser: "A controlled drug is adjusted by a pharmacist with a pharmacy licence",
      not_pending: "This adjustment has already been decided",
      same_person: "Someone other than whoever asked for it decides it",
      not_requester: "Only whoever asked for it may withdraw it",
    }[code]}`);
    this.name = "StockAdjustmentError";
  }
}

/** Which way each kind moves stock: off the shelf, onto it, or either. */
const SIGN: Record<StockAdjustmentKind, -1 | 1 | 0> = { expired: -1, damaged: -1, lost: -1, found: 1, correction: 0 };

interface BatchFacts {
  id: string;
  expiresOn: string | null;
  totalCostCents: number;
  quantityReceived: number;
  schedule: string | null;
  onHand: number;
}

/** These batches, with what the store holds of each. */
async function batchFacts(tx: AppDb, storeId: string, ids: string[]): Promise<Map<string, BatchFacts>> {
  const rows = await tx
    .select({
      id: stockBatches.id,
      expiresOn: stockBatches.expiresOn,
      totalCostCents: stockBatches.totalCostCents,
      quantityReceived: stockBatches.quantityReceived,
      schedule: drugCatalogue.controlledSchedule,
      onHand: sql<string>`coalesce((SELECT sum(m.quantity) FROM stock_movements m WHERE m.batch_id = ${stockBatches.id} AND m.store_id = ${storeId}), 0)`,
    })
    .from(stockBatches)
    .innerJoin(stockItems, eq(stockItems.id, stockBatches.stockItemId))
    .leftJoin(drugCatalogue, eq(drugCatalogue.code, stockItems.drugCode))
    .where(inArray(stockBatches.id, ids));
  return new Map(rows.map(r => [r.id, { ...r, onHand: Number(r.onHand) }]));
}

/** Asks for batches in a store to be adjusted; nothing moves until a second person approves. */
export async function requestStockAdjustment(
  tx: AppDb,
  facilityId: string,
  input: { storeId: string; kind: StockAdjustmentKind; reason: string; lines: { batchId: string; quantity: number }[] },
  actor: DispenseActor,
  today = businessDate(),
): Promise<AdjustmentRow> {
  const [store] = await tx.select({ id: stores.id }).from(stores).where(eq(stores.id, input.storeId)).limit(1);
  if (!store)
    throw new StockAdjustmentError("store_not_found");
  const lines = input.lines.map(l => ({ ...l, batchId: l.batchId.toLowerCase() }));
  const facts = await batchFacts(tx, store.id, lines.map(l => l.batchId));

  const values = lines.map((line, index) => {
    const number = index + 1;
    const batch = facts.get(line.batchId);
    if (!batch)
      throw new StockAdjustmentError("batch_not_found", number);
    const sign = SIGN[input.kind];
    if (sign !== 0 && Math.sign(line.quantity) !== sign)
      throw new StockAdjustmentError("wrong_sign", number);
    if (input.kind === "expired" && !(batch.expiresOn !== null && batch.expiresOn < today))
      throw new StockAdjustmentError("not_expired", number);
    // A first look; approval looks again under the batch's lock.
    if (line.quantity < 0 && batch.onHand < -line.quantity)
      throw new StockAdjustmentError("not_enough_stock", number);
    if (batch.schedule && !(actor.roles.includes("pharmacist") && actor.licenceProfession === "pharmacy"))
      throw new StockAdjustmentError("controlled_dispenser", number);
    return { batchId: line.batchId, quantity: line.quantity, valueCents: Math.round(line.quantity * batch.totalCostCents / batch.quantityReceived) };
  });

  const [adjustment] = await tx.insert(stockAdjustments).values({ facilityId, storeId: store.id, kind: input.kind, reason: input.reason, status: "pending", requestedBy: actor.membershipId }).returning();
  await tx.insert(stockAdjustmentLines).values(values.map(v => ({ facilityId, adjustmentId: adjustment.id, ...v })));
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "stock_adjustment.requested",
    entityType: "stock_adjustment",
    entityId: adjustment.id,
    summary: `Asked for a stock adjustment (${input.kind}) of ${values.length} batch${values.length === 1 ? "" : "es"}`,
    detail: { storeId: store.id, kind: input.kind, reason: input.reason, lines: values },
  });
  return adjustment;
}

async function lockPending(tx: AppDb, id: string): Promise<AdjustmentRow> {
  const [adjustment] = await tx.select().from(stockAdjustments).where(eq(stockAdjustments.id, id)).for("update").limit(1);
  if (!adjustment)
    throw new StockAdjustmentError("not_found");
  if (adjustment.status !== "pending")
    throw new StockAdjustmentError("not_pending");
  return adjustment;
}

/** Approves an adjustment, by someone other than its asker: its batches move now. */
export async function approveStockAdjustment(tx: AppDb, facilityId: string, id: string, actor: PatientActor): Promise<AdjustmentRow> {
  const adjustment = await lockPending(tx, id);
  if (adjustment.requestedBy === actor.membershipId)
    throw new StockAdjustmentError("same_person");
  const lines = await tx.select().from(stockAdjustmentLines).where(eq(stockAdjustmentLines.adjustmentId, id)).orderBy(asc(stockAdjustmentLines.id));
  await lockBatches(tx, facilityId, lines.map(l => l.batchId));
  const facts = await batchFacts(tx, adjustment.storeId, lines.map(l => l.batchId));
  for (const [index, line] of lines.entries()) {
    if (line.quantity < 0 && facts.get(line.batchId)!.onHand < -line.quantity)
      throw new StockAdjustmentError("not_enough_stock", index + 1);
  }

  await tx.insert(stockMovements).values(lines.map(l => ({
    facilityId,
    storeId: adjustment.storeId,
    batchId: l.batchId,
    kind: "adjustment" as const,
    quantity: l.quantity,
    stockAdjustmentLineId: l.id,
    recordedBy: actor.membershipId,
  })));
  const [approved] = await tx.update(stockAdjustments).set({ status: "approved", decidedBy: actor.membershipId, decidedAt: new Date() }).where(eq(stockAdjustments.id, id)).returning();
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "stock_adjustment.approved",
    entityType: "stock_adjustment",
    entityId: id,
    summary: `Approved a stock adjustment (${adjustment.kind})`,
    detail: { valueCents: lines.reduce((sum, l) => sum + l.valueCents, 0) },
  });
  return approved;
}

/** Closes a pending adjustment unmoved: rejected by a second person, or withdrawn by its asker. */
export async function closeStockAdjustment(tx: AppDb, facilityId: string, id: string, how: "rejected" | "withdrawn", actor: PatientActor): Promise<AdjustmentRow> {
  const adjustment = await lockPending(tx, id);
  if (how === "rejected" && adjustment.requestedBy === actor.membershipId)
    throw new StockAdjustmentError("same_person");
  if (how === "withdrawn" && adjustment.requestedBy !== actor.membershipId)
    throw new StockAdjustmentError("not_requester");
  const [closed] = await tx.update(stockAdjustments).set({ status: how, decidedBy: actor.membershipId, decidedAt: new Date() }).where(eq(stockAdjustments.id, id)).returning();
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: how === "rejected" ? "stock_adjustment.rejected" : "stock_adjustment.withdrawn",
    entityType: "stock_adjustment",
    entityId: id,
    summary: `${how === "rejected" ? "Rejected" : "Withdrew"} a stock adjustment (${adjustment.kind})`,
  });
  return closed;
}

export interface ShownStockAdjustment {
  id: string;
  storeId: string;
  kind: StockAdjustmentKind;
  reason: string;
  status: StockAdjustmentStatus;
  requestedAt: Date;
  decidedAt: Date | null;
  /** Signed: below zero a loss, at the batches' cost. */
  valueCents: number;
  lines: { batchId: string; batchNumber: string | null; expiresOn: string | null; code: string; name: string; quantity: number; valueCents: number }[];
}

/** Adjustments, newest first, 50 a page; `pending` is the approvers' list. Not patient data, so not audited. */
export async function listStockAdjustments(tx: AppDb, filter: { status?: StockAdjustmentStatus; storeId?: string; id?: string; offset?: number } = {}): Promise<ShownStockAdjustment[]> {
  const adjustments = await tx.select().from(stockAdjustments).where(and(
    filter.status ? eq(stockAdjustments.status, filter.status) : undefined,
    filter.storeId ? eq(stockAdjustments.storeId, filter.storeId) : undefined,
    filter.id ? eq(stockAdjustments.id, filter.id) : undefined,
  )).orderBy(desc(stockAdjustments.requestedAt), desc(stockAdjustments.id)).limit(50).offset(filter.offset ?? 0);
  if (adjustments.length === 0)
    return [];
  const lines = await tx
    .select({ adjustmentId: stockAdjustmentLines.adjustmentId, batchId: stockAdjustmentLines.batchId, batchNumber: stockBatches.batchNumber, expiresOn: stockBatches.expiresOn, code: billableItems.code, name: billableItems.name, quantity: stockAdjustmentLines.quantity, valueCents: stockAdjustmentLines.valueCents })
    .from(stockAdjustmentLines)
    .innerJoin(stockBatches, eq(stockBatches.id, stockAdjustmentLines.batchId))
    .innerJoin(stockItems, eq(stockItems.id, stockBatches.stockItemId))
    .innerJoin(billableItems, eq(billableItems.id, stockItems.billableItemId))
    .where(inArray(stockAdjustmentLines.adjustmentId, adjustments.map(a => a.id)))
    .orderBy(asc(billableItems.code));
  const linesOf = Map.groupBy(lines, l => l.adjustmentId);
  return adjustments.map((a) => {
    const own = (linesOf.get(a.id) ?? []).map(({ adjustmentId: _, ...l }) => l);
    return { id: a.id, storeId: a.storeId, kind: a.kind, reason: a.reason, status: a.status, requestedAt: a.requestedAt, decidedAt: a.decidedAt, valueCents: own.reduce((sum, l) => sum + l.valueCents, 0), lines: own };
  });
}

export async function stockAdjustmentShown(tx: AppDb, id: string): Promise<ShownStockAdjustment> {
  const [found] = await listStockAdjustments(tx, { id });
  if (!found)
    throw new StockAdjustmentError("not_found");
  return found;
}
