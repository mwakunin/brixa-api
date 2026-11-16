import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { billableItems, stockBatches, stockItems, stockMovements, stockTakeLines, stockTakes, stores } from "@/db/schema";

import type { DispenseActor } from "./dispensing";

import { recordAudit } from "./audit";
import { isUniqueViolation } from "./db-errors";
import { issueNumber } from "./number-series";
import { requestStockAdjustment, StockAdjustmentError } from "./stock-adjustments";
import { TRANSFER_STAFF } from "./transfers";

/**
 * Stock takes (SCHEMA.md §8, P4 slice 5, decided 2026-11-16): a blind count
 * of a store, the store open while it runs. Each line's expected quantity is
 * the ledger at the moment it was counted, so stock moving meanwhile does
 * not skew it. Submitting asks for one `correction` adjustment for the
 * differences, which a second person approves (rule 24).
 */

type TakeRow = typeof stockTakes.$inferSelect;

export type StockTakeErrorCode
  = | "not_found"
    | "store_not_found"
    | "store_retired"
    | "ward_store_only"
    | "count_open"
    | "item_not_found"
    | "batch_not_found"
    | "not_counting"
    | "uncounted"
    | "controlled_dispenser";

export class StockTakeError extends Error {
  constructor(readonly code: StockTakeErrorCode) {
    super({
      not_found: "No such stock take",
      store_not_found: "No such store",
      store_retired: "That store is retired",
      ward_store_only: "Nurses count a ward's store only",
      count_open: "A count of this store is open already: submit or cancel it first",
      item_not_found: "One of these is not a stock item of this facility",
      batch_not_found: "No such batch",
      not_counting: "This count has been submitted or cancelled",
      uncounted: "Every line is counted, nought included, before the count is submitted",
      controlled_dispenser: "A count with a controlled drug is submitted by a pharmacist with a pharmacy licence",
    }[code]);
    this.name = "StockTakeError";
  }
}

const isStoreStaff = (actor: DispenseActor) => actor.roles.some(r => (TRANSFER_STAFF as readonly string[]).includes(r));

async function storeFor(tx: AppDb, storeId: string, actor: DispenseActor): Promise<{ id: string; name: string }> {
  const [store] = await tx.select({ id: stores.id, name: stores.name, kind: stores.kind, isActive: stores.isActive }).from(stores).where(eq(stores.id, storeId)).limit(1);
  if (!store)
    throw new StockTakeError("store_not_found");
  if (!store.isActive)
    throw new StockTakeError("store_retired");
  if (!isStoreStaff(actor) && store.kind !== "ward")
    throw new StockTakeError("ward_store_only");
  return store;
}

/** Opens a count of a store, or of chosen items in it: a sheet of every batch it holds of them. */
export async function openStockTake(tx: AppDb, facilityId: string, input: { storeId: string; stockItemIds?: string[] }, actor: DispenseActor): Promise<TakeRow> {
  const store = await storeFor(tx, input.storeId, actor);
  const itemIds = input.stockItemIds?.map(id => id.toLowerCase());
  if (itemIds) {
    const found = await tx.select({ id: stockItems.id }).from(stockItems).where(inArray(stockItems.id, itemIds));
    if (found.length !== new Set(itemIds).size)
      throw new StockTakeError("item_not_found");
  }
  const onHand = sql<string>`sum(${stockMovements.quantity})`;
  const held = await tx
    .select({ batchId: stockMovements.batchId })
    .from(stockMovements)
    .innerJoin(stockBatches, eq(stockBatches.id, stockMovements.batchId))
    .where(and(eq(stockMovements.storeId, store.id), itemIds ? inArray(stockBatches.stockItemId, itemIds) : undefined))
    .groupBy(stockMovements.batchId)
    .having(sql`${onHand} <> 0`);

  let take: TakeRow;
  try {
    [take] = await tx.insert(stockTakes).values({
      facilityId,
      number: await issueNumber(tx, facilityId, "stock_take"),
      storeId: store.id,
      scope: itemIds ? "items" : "store",
      status: "counting",
      openedBy: actor.membershipId,
    }).returning();
  }
  catch (err) {
    if (isUniqueViolation(err))
      throw new StockTakeError("count_open");
    throw err;
  }
  if (held.length > 0)
    await tx.insert(stockTakeLines).values(held.map(h => ({ facilityId, stockTakeId: take.id, batchId: h.batchId })));
  await recordAudit(tx, { facilityId, actorId: actor.userId, action: "stock_take.opened", entityType: "stock_take", entityId: take.id, summary: `Opened stock take ${take.number} of ${store.name}`, detail: { storeId: store.id, scope: take.scope, lines: held.length } });
  return take;
}

async function lockCounting(tx: AppDb, id: string, actor: DispenseActor): Promise<TakeRow> {
  const [take] = await tx.select().from(stockTakes).where(eq(stockTakes.id, id)).for("update").limit(1);
  if (!take)
    throw new StockTakeError("not_found");
  if (take.status !== "counting")
    throw new StockTakeError("not_counting");
  await storeFor(tx, take.storeId, actor);
  return take;
}

/**
 * Records counts, now, by this member: a batch on the sheet is counted (again,
 * if it was); one found on the shelf and not on it is added.
 */
export async function recordCounts(tx: AppDb, facilityId: string, id: string, counts: { batchId: string; quantity: number }[], actor: DispenseActor): Promise<TakeRow> {
  const take = await lockCounting(tx, id, actor);
  const ids = counts.map(c => c.batchId.toLowerCase());
  const batches = await tx.select({ id: stockBatches.id }).from(stockBatches).where(inArray(stockBatches.id, ids));
  if (batches.length !== new Set(ids).size)
    throw new StockTakeError("batch_not_found");
  const at = new Date();
  for (const [index, count] of counts.entries()) {
    await tx.insert(stockTakeLines)
      .values({ facilityId, stockTakeId: take.id, batchId: ids[index], countedQuantity: count.quantity, countedAt: at, countedBy: actor.membershipId })
      .onConflictDoUpdate({ target: [stockTakeLines.stockTakeId, stockTakeLines.batchId], set: { countedQuantity: count.quantity, countedAt: at, countedBy: actor.membershipId } });
  }
  await recordAudit(tx, { facilityId, actorId: actor.userId, action: "stock_take.counted", entityType: "stock_take", entityId: take.id, summary: `Counted ${counts.length} batch${counts.length === 1 ? "" : "es"} for ${take.number}`, detail: { batches: ids.length } });
  return take;
}

/** What the store held of a batch at the moment it was counted. */
async function expectedAt(tx: AppDb, storeId: string, batchId: string, at: Date): Promise<number> {
  const [{ total }] = await tx.select({ total: sql<string>`coalesce(sum(${stockMovements.quantity}), 0)` }).from(stockMovements).where(and(eq(stockMovements.storeId, storeId), eq(stockMovements.batchId, batchId), lte(stockMovements.recordedAt, at)));
  return Number(total);
}

/**
 * Submits a count once every line is counted: each line's expected quantity
 * is fixed, and one correction is asked for the differences, for a second
 * person to approve; none is asked for when nothing differed.
 */
export async function submitStockTake(tx: AppDb, facilityId: string, id: string, actor: DispenseActor): Promise<TakeRow> {
  const take = await lockCounting(tx, id, actor);
  const lines = await tx.select().from(stockTakeLines).where(eq(stockTakeLines.stockTakeId, take.id));
  if (lines.some(l => l.countedQuantity === null))
    throw new StockTakeError("uncounted");

  const differences: { batchId: string; quantity: number }[] = [];
  for (const line of lines) {
    const expected = await expectedAt(tx, take.storeId, line.batchId, line.countedAt!);
    await tx.update(stockTakeLines).set({ expectedQuantity: expected }).where(eq(stockTakeLines.id, line.id));
    if (line.countedQuantity! !== expected)
      differences.push({ batchId: line.batchId, quantity: line.countedQuantity! - expected });
  }

  let adjustmentId: string | null = null;
  if (differences.length > 0) {
    try {
      adjustmentId = (await requestStockAdjustment(tx, facilityId, { storeId: take.storeId, kind: "correction", reason: `Stock take ${take.number}`, lines: differences }, actor)).id;
    }
    catch (err) {
      if (err instanceof StockAdjustmentError && err.code === "controlled_dispenser")
        throw new StockTakeError("controlled_dispenser");
      throw err;
    }
  }
  const [submitted] = await tx.update(stockTakes).set({ status: "submitted", submittedBy: actor.membershipId, submittedAt: new Date(), adjustmentId }).where(eq(stockTakes.id, take.id)).returning();
  await recordAudit(tx, { facilityId, actorId: actor.userId, action: "stock_take.submitted", entityType: "stock_take", entityId: take.id, summary: `Submitted stock take ${take.number}: ${differences.length} difference${differences.length === 1 ? "" : "s"}`, detail: { adjustmentId, differences: differences.length } });
  return submitted;
}

/** Cancels an open count, with a reason; nothing it counted moves. */
export async function cancelStockTake(tx: AppDb, facilityId: string, id: string, reason: string, actor: DispenseActor): Promise<TakeRow> {
  const take = await lockCounting(tx, id, actor);
  const [cancelled] = await tx.update(stockTakes).set({ status: "cancelled", cancelledBy: actor.membershipId, cancelledAt: new Date(), cancellationReason: reason }).where(eq(stockTakes.id, take.id)).returning();
  await recordAudit(tx, { facilityId, actorId: actor.userId, action: "stock_take.cancelled", entityType: "stock_take", entityId: take.id, summary: `Cancelled stock take ${take.number}: ${reason}`, detail: { reason } });
  return cancelled;
}

export interface ShownStockTake {
  id: string;
  number: string;
  storeId: string;
  scope: TakeRow["scope"];
  status: TakeRow["status"];
  openedAt: Date;
  submittedAt: Date | null;
  adjustmentId: string | null;
  /** Blind while counting: `expected` and `difference` are null until submitted. */
  lines: { batchId: string; code: string; name: string; baseUnit: string; batchNumber: string | null; expiresOn: string | null; counted: number | null; countedAt: Date | null; expected: number | null; difference: number | null }[];
}

/** A count as its sheet: blind while counting. Not patient data, so not audited. */
export async function stockTakeShown(tx: AppDb, id: string): Promise<ShownStockTake> {
  const [take] = await tx.select().from(stockTakes).where(eq(stockTakes.id, id)).limit(1);
  if (!take)
    throw new StockTakeError("not_found");
  const lines = await tx
    .select({ line: stockTakeLines, code: billableItems.code, name: billableItems.name, baseUnit: stockItems.baseUnit, batchNumber: stockBatches.batchNumber, expiresOn: stockBatches.expiresOn })
    .from(stockTakeLines)
    .innerJoin(stockBatches, eq(stockBatches.id, stockTakeLines.batchId))
    .innerJoin(stockItems, eq(stockItems.id, stockBatches.stockItemId))
    .innerJoin(billableItems, eq(billableItems.id, stockItems.billableItemId))
    .where(eq(stockTakeLines.stockTakeId, id))
    .orderBy(asc(billableItems.code), sql`${stockBatches.expiresOn} ASC NULLS LAST`);
  const submitted = take.status === "submitted";
  return {
    id: take.id,
    number: take.number,
    storeId: take.storeId,
    scope: take.scope,
    status: take.status,
    openedAt: take.openedAt,
    submittedAt: take.submittedAt,
    adjustmentId: take.adjustmentId,
    lines: lines.map(({ line, ...rest }) => ({
      batchId: line.batchId,
      ...rest,
      counted: line.countedQuantity,
      countedAt: line.countedAt,
      expected: submitted ? line.expectedQuantity : null,
      difference: submitted && line.countedQuantity !== null && line.expectedQuantity !== null ? line.countedQuantity - line.expectedQuantity : null,
    })),
  };
}

/** Counts, newest first, 50 a page; `?status=counting` for those open. */
export async function listStockTakes(tx: AppDb, filter: { storeId?: string; status?: TakeRow["status"]; offset?: number } = {}): Promise<Omit<ShownStockTake, "lines">[]> {
  const rows = await tx.select().from(stockTakes).where(and(filter.storeId ? eq(stockTakes.storeId, filter.storeId) : undefined, filter.status ? eq(stockTakes.status, filter.status) : undefined)).orderBy(desc(stockTakes.openedAt), desc(stockTakes.number)).limit(50).offset(filter.offset ?? 0);
  return rows.map(t => ({ id: t.id, number: t.number, storeId: t.storeId, scope: t.scope, status: t.status, openedAt: t.openedAt, submittedAt: t.submittedAt, adjustmentId: t.adjustmentId }));
}
