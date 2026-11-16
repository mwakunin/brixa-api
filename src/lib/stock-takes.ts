import { and, asc, desc, eq, getTableColumns, inArray, isNotNull, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { billableItems, drugCatalogue, stockAdjustments, stockBatches, stockItems, stockMovements, stockTakeLines, stockTakes, stores } from "@/db/schema";

import type { DispenseActor } from "./dispensing";

import { recordAudit } from "./audit";
import { isUniqueViolation } from "./db-errors";
import { mayGiveControlled } from "./dispensing";
import { STOCK_READERS } from "./goods-received";
import { issueNumber } from "./number-series";
import { requestStockAdjustment, StockAdjustmentError } from "./stock-adjustments";
import { TRANSFER_STAFF } from "./transfers";

/**
 * Stock takes (SCHEMA.md §8, P4 slice 5, decided 2026-11-16): a blind count
 * of a store, the store open while it runs. Each line's expected quantity is
 * the ledger as committed when it was counted, read then and kept hidden, so
 * stock moving meanwhile does not skew it. Submitting asks for one `correction` adjustment for the
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
    | "controlled_dispenser"
    | "correction_pending"
    | "not_enough_stock"
    | "value_too_large";

export class StockTakeError extends Error {
  constructor(readonly code: StockTakeErrorCode, options?: ErrorOptions) {
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
      correction_pending: "The last count of this store waits for its correction to be approved or rejected",
      not_enough_stock: "Stock has left the store since it was counted, more than the correction would take off: count those lines again",
      value_too_large: "The differences are worth more than one correction records: count fewer items at a time",
    }[code], options);
    this.name = "StockTakeError";
  }
}

/** Whether any of these batches is of a controlled drug. */
async function countsControlled(tx: AppDb, batchIds: string[]): Promise<boolean> {
  if (batchIds.length === 0)
    return false;
  const [found] = await tx
    .select({ id: stockBatches.id })
    .from(stockBatches)
    .innerJoin(stockItems, eq(stockItems.id, stockBatches.stockItemId))
    .innerJoin(drugCatalogue, eq(drugCatalogue.code, stockItems.drugCode))
    .where(and(inArray(stockBatches.id, batchIds), isNotNull(drugCatalogue.controlledSchedule)))
    .limit(1);
  return found !== undefined;
}

const isStoreStaff = (actor: DispenseActor) => actor.roles.some(r => (TRANSFER_STAFF as readonly string[]).includes(r));
/** Whether this member reads every store's stock: a nurse, who does not, reads a ward's counts only. */
const readsEveryStore = (actor: DispenseActor) => actor.roles.some(r => (STOCK_READERS as readonly string[]).includes(r));

/** The store to count, if this member counts it; a retired one only to cancel a count left open in it. */
async function storeFor(tx: AppDb, storeId: string, actor: DispenseActor, retired: "refused" | "allowed" = "refused"): Promise<{ id: string; name: string }> {
  const [store] = await tx.select({ id: stores.id, name: stores.name, kind: stores.kind, isActive: stores.isActive }).from(stores).where(eq(stores.id, storeId)).limit(1);
  if (!store)
    throw new StockTakeError("store_not_found");
  if (!store.isActive && retired === "refused")
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
  // Counted again before the last correction is decided, the same difference would be asked for twice.
  // Read after the insert, which waits for a submission of the store's open count still being written
  // (one open count per store), so the correction that came with it is seen.
  const [waiting] = await tx
    .select({ id: stockTakes.id })
    .from(stockTakes)
    .innerJoin(stockAdjustments, eq(stockAdjustments.id, stockTakes.adjustmentId))
    .where(and(eq(stockTakes.storeId, store.id), eq(stockAdjustments.status, "pending")))
    .limit(1);
  if (waiting)
    throw new StockTakeError("correction_pending");
  // The sheet, read once no correction waits: one approved a moment ago has moved its stock already.
  const onHand = sql<string>`sum(${stockMovements.quantity})`;
  const held = await tx
    .select({ batchId: stockMovements.batchId })
    .from(stockMovements)
    .innerJoin(stockBatches, eq(stockBatches.id, stockMovements.batchId))
    .where(and(eq(stockMovements.storeId, store.id), itemIds ? inArray(stockBatches.stockItemId, itemIds) : undefined))
    .groupBy(stockMovements.batchId)
    .having(sql`${onHand} <> 0`);
  if (held.length > 0)
    await tx.insert(stockTakeLines).values(held.map(h => ({ facilityId, stockTakeId: take.id, batchId: h.batchId })));
  await recordAudit(tx, { facilityId, actorId: actor.userId, action: "stock_take.opened", entityType: "stock_take", entityId: take.id, summary: `Opened stock take ${take.number} of ${store.name}`, detail: { storeId: store.id, scope: take.scope, lines: held.length } });
  return take;
}

async function lockCounting(tx: AppDb, id: string, actor: DispenseActor, retired: "refused" | "allowed" = "refused"): Promise<TakeRow> {
  const [take] = await tx.select().from(stockTakes).where(eq(stockTakes.id, id)).for("update").limit(1);
  if (!take)
    throw new StockTakeError("not_found");
  if (take.status !== "counting")
    throw new StockTakeError("not_counting");
  await storeFor(tx, take.storeId, actor, retired);
  return take;
}

/**
 * Records counts, now, by this member: a batch on the sheet is counted (again,
 * if it was); one found on the shelf and not on it is added. Beside each goes
 * what the ledger holds of it as committed now, hidden until the count is
 * submitted: a movement still open as the shelf is counted has not happened
 * there yet, whenever its transaction began.
 */
export async function recordCounts(tx: AppDb, facilityId: string, id: string, counts: { batchId: string; quantity: number }[], actor: DispenseActor): Promise<TakeRow> {
  const take = await lockCounting(tx, id, actor);
  const ids = counts.map(c => c.batchId.toLowerCase());
  const batches = await tx.select({ id: stockBatches.id }).from(stockBatches).where(inArray(stockBatches.id, ids));
  if (batches.length !== new Set(ids).size)
    throw new StockTakeError("batch_not_found");
  const at = new Date();
  const held = await committedOnHand(tx, take.storeId, ids);
  await tx.insert(stockTakeLines)
    .values(counts.map((count, index) => ({ facilityId, stockTakeId: take.id, batchId: ids[index], countedQuantity: count.quantity, countedAt: at, countedBy: actor.membershipId, expectedQuantity: held.get(ids[index]) ?? 0 })))
    .onConflictDoUpdate({
      target: [stockTakeLines.stockTakeId, stockTakeLines.batchId],
      set: { countedQuantity: sql`excluded.counted_quantity`, countedAt: sql`excluded.counted_at`, countedBy: sql`excluded.counted_by`, expectedQuantity: sql`excluded.expected_quantity` },
    });
  await recordAudit(tx, { facilityId, actorId: actor.userId, action: "stock_take.counted", entityType: "stock_take", entityId: take.id, summary: `Counted ${counts.length} batch${counts.length === 1 ? "" : "es"} for ${take.number}`, detail: { batches: ids.length } });
  return take;
}

/**
 * What the ledger holds of each batch in a store, as one statement sees it:
 * every movement committed before it began, none still open (read committed).
 * A batch with no movement there is absent, and holds nought.
 */
async function committedOnHand(tx: AppDb, storeId: string, batchIds: string[]): Promise<Map<string, number>> {
  const rows = await tx
    .select({ batchId: stockMovements.batchId, total: sql<string>`sum(${stockMovements.quantity})` })
    .from(stockMovements)
    .where(and(eq(stockMovements.storeId, storeId), inArray(stockMovements.batchId, batchIds)))
    .groupBy(stockMovements.batchId);
  return new Map(rows.map(r => [r.batchId, Number(r.total)]));
}

/**
 * Submits a count once every line is counted: one correction is asked for
 * the differences from what was expected as each was counted, for a second
 * person to approve; none is asked for when nothing differed. A count with a
 * controlled drug is the pharmacist's, though nothing differs.
 */
export async function submitStockTake(tx: AppDb, facilityId: string, id: string, actor: DispenseActor): Promise<TakeRow> {
  const take = await lockCounting(tx, id, actor);
  const lines = await tx.select().from(stockTakeLines).where(eq(stockTakeLines.stockTakeId, take.id));
  if (lines.some(l => l.countedQuantity === null))
    throw new StockTakeError("uncounted");

  if (!mayGiveControlled(actor) && await countsControlled(tx, lines.map(l => l.batchId)))
    throw new StockTakeError("controlled_dispenser");

  const differences = lines
    .filter(l => l.countedQuantity !== l.expectedQuantity)
    .map(l => ({ batchId: l.batchId, quantity: l.countedQuantity! - l.expectedQuantity! }));

  let adjustmentId: string | null = null;
  if (differences.length > 0) {
    try {
      adjustmentId = (await requestStockAdjustment(tx, facilityId, { storeId: take.storeId, kind: "correction", reason: `Stock take ${take.number}`, lines: differences }, actor)).id;
    }
    catch (err) {
      if (err instanceof StockAdjustmentError && (err.code === "not_enough_stock" || err.code === "value_too_large" || err.code === "controlled_dispenser"))
        throw new StockTakeError(err.code, { cause: err });
      throw err;
    }
  }
  const [submitted] = await tx.update(stockTakes).set({ status: "submitted", submittedBy: actor.membershipId, submittedAt: new Date(), adjustmentId }).where(eq(stockTakes.id, take.id)).returning();
  await recordAudit(tx, { facilityId, actorId: actor.userId, action: "stock_take.submitted", entityType: "stock_take", entityId: take.id, summary: `Submitted stock take ${take.number}: ${differences.length} difference${differences.length === 1 ? "" : "s"}`, detail: { adjustmentId, differences: differences.length } });
  return submitted;
}

/** Cancels an open count, with a reason, though its store was retired since; nothing it counted moves. */
export async function cancelStockTake(tx: AppDb, facilityId: string, id: string, reason: string, actor: DispenseActor): Promise<TakeRow> {
  const take = await lockCounting(tx, id, actor, "allowed");
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

/**
 * A count as its sheet: blind while counting. Not patient data, so not
 * audited. A submitted count shows what its store held, so a nurse, who
 * reads no other store's stock, is shown a ward's count only: another is
 * not there for them.
 */
export async function stockTakeShown(tx: AppDb, id: string, actor: DispenseActor): Promise<ShownStockTake> {
  const [take] = await tx
    .select(getTableColumns(stockTakes))
    .from(stockTakes)
    .innerJoin(stores, eq(stores.id, stockTakes.storeId))
    .where(and(eq(stockTakes.id, id), readsEveryStore(actor) ? undefined : eq(stores.kind, "ward")))
    .limit(1);
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
export async function listStockTakes(tx: AppDb, filter: { storeId?: string; status?: TakeRow["status"]; offset?: number }, actor: DispenseActor): Promise<Omit<ShownStockTake, "lines">[]> {
  const rows = await tx
    .select(getTableColumns(stockTakes))
    .from(stockTakes)
    .innerJoin(stores, eq(stores.id, stockTakes.storeId))
    .where(and(
      filter.storeId ? eq(stockTakes.storeId, filter.storeId) : undefined,
      filter.status ? eq(stockTakes.status, filter.status) : undefined,
      readsEveryStore(actor) ? undefined : eq(stores.kind, "ward"),
    ))
    .orderBy(desc(stockTakes.openedAt), desc(stockTakes.number))
    .limit(50)
    .offset(filter.offset ?? 0);
  return rows.map(t => ({ id: t.id, number: t.number, storeId: t.storeId, scope: t.scope, status: t.status, openedAt: t.openedAt, submittedAt: t.submittedAt, adjustmentId: t.adjustmentId }));
}
