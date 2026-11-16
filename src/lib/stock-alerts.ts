import { and, asc, eq, gt, inArray, isNotNull, lte, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { billableItems, reorderLevels, stockBatches, stockItems, stockMovements, stockTransferBatches, stockTransfers, stores } from "@/db/schema";

import { addDays, businessDate } from "./dates";
import { EXPIRY_WARNING_DAYS } from "./goods-received";

/**
 * Expiry and low-stock alerts (P4 slice 6, decided 2026-11-16; question 10):
 * worked out from the ledger each time they are read, never stored, so none
 * is a night behind and none is dismissed. An alert lasts while its cause
 * does: writing a batch off, moving it or restocking clears it. They name no
 * patient, so reading them is not audited.
 */

export interface AlertedBatch {
  storeId: string;
  storeName: string;
  stockItemId: string;
  code: string;
  name: string;
  baseUnit: string;
  batchId: string;
  batchNumber: string | null;
  expiresOn: string;
  /** Days from today to its last good day: below nought once it has passed. */
  daysLeft: number;
  onHand: number;
}

export interface AlertedItem {
  storeId: string;
  storeName: string;
  stockItemId: string;
  code: string;
  name: string;
  baseUnit: string;
  onHand: number;
  reorderLevel: number;
  /** Sent to the store and not received yet: shown beside, not counted, as it is not on the shelf. */
  inTransit: number;
}

export interface StockAlerts {
  /** Past their last good day and still held: to write off. */
  expired: AlertedBatch[];
  /** Within `EXPIRY_WARNING_DAYS` of it. */
  expiring: AlertedBatch[];
  /** Strictly below the store's reorder level, so a level of nought flags nothing. */
  belowReorder: AlertedItem[];
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

/** Batches held anywhere (or in one store) whose last good day is within the warning window, or past. */
async function datedBatches(tx: AppDb, storeId: string | undefined, today: string) {
  const onHand = sql<string>`sum(${stockMovements.quantity})`;
  return tx
    .select({
      storeId: stockMovements.storeId,
      stockItemId: stockBatches.stockItemId,
      batchId: stockBatches.id,
      batchNumber: stockBatches.batchNumber,
      expiresOn: stockBatches.expiresOn,
      onHand,
    })
    .from(stockMovements)
    .innerJoin(stockBatches, eq(stockBatches.id, stockMovements.batchId))
    .where(and(
      storeId ? eq(stockMovements.storeId, storeId) : undefined,
      isNotNull(stockBatches.expiresOn),
      lte(stockBatches.expiresOn, addDays(today, EXPIRY_WARNING_DAYS)),
    ))
    .groupBy(stockMovements.storeId, stockBatches.id)
    .having(gt(onHand, sql`0`))
    .orderBy(asc(stockBatches.expiresOn), asc(stockBatches.createdAt));
}

/** Each live store's reorder levels above nought for live items, with what the store holds and what is on its way. */
async function lowItems(tx: AppDb, storeId: string | undefined) {
  const held = tx
    .select({ storeId: stockMovements.storeId, stockItemId: stockBatches.stockItemId, quantity: sql<string>`sum(${stockMovements.quantity})`.as("held_quantity") })
    .from(stockMovements)
    .innerJoin(stockBatches, eq(stockBatches.id, stockMovements.batchId))
    .groupBy(stockMovements.storeId, stockBatches.stockItemId)
    .as("held");
  const onTheWay = tx
    .select({ storeId: stockTransfers.toStoreId, stockItemId: stockBatches.stockItemId, quantity: sql<string>`sum(${stockTransferBatches.quantitySent})`.as("sent_quantity") })
    .from(stockTransferBatches)
    .innerJoin(stockTransfers, eq(stockTransfers.id, stockTransferBatches.transferId))
    .innerJoin(stockBatches, eq(stockBatches.id, stockTransferBatches.batchId))
    .where(eq(stockTransfers.status, "sent"))
    .groupBy(stockTransfers.toStoreId, stockBatches.stockItemId)
    .as("on_the_way");
  return tx
    .select({
      storeId: reorderLevels.storeId,
      stockItemId: reorderLevels.stockItemId,
      level: reorderLevels.level,
      onHand: sql<string>`coalesce(${held.quantity}, 0)`,
      inTransit: sql<string>`coalesce(${onTheWay.quantity}, 0)`,
    })
    .from(reorderLevels)
    .innerJoin(stores, and(eq(stores.id, reorderLevels.storeId), eq(stores.isActive, true)))
    .innerJoin(stockItems, and(eq(stockItems.id, reorderLevels.stockItemId), eq(stockItems.isActive, true)))
    .leftJoin(held, and(eq(held.storeId, reorderLevels.storeId), eq(held.stockItemId, reorderLevels.stockItemId)))
    .leftJoin(onTheWay, and(eq(onTheWay.storeId, reorderLevels.storeId), eq(onTheWay.stockItemId, reorderLevels.stockItemId)))
    .where(and(storeId ? eq(reorderLevels.storeId, storeId) : undefined, sql`coalesce(${held.quantity}, 0) < ${reorderLevels.level}`));
}

/** The pharmacy's and stores' alerts, for every store or one, as of `today` (Kenyan date). */
export async function stockAlerts(tx: AppDb, filter: { storeId?: string }, today = businessDate()): Promise<StockAlerts> {
  const batches = await datedBatches(tx, filter.storeId, today);
  const low = await lowItems(tx, filter.storeId);
  const storeIds = [...new Set([...batches, ...low].map(r => r.storeId))];
  const itemIds = [...new Set([...batches, ...low].map(r => r.stockItemId))];
  if (itemIds.length === 0)
    return { expired: [], expiring: [], belowReorder: [] };

  const storeNames = new Map((await tx.select({ id: stores.id, name: stores.name }).from(stores).where(inArray(stores.id, storeIds))).map(s => [s.id, s.name]));
  const items = new Map((await tx
    .select({ id: stockItems.id, code: billableItems.code, name: billableItems.name, baseUnit: stockItems.baseUnit })
    .from(stockItems)
    .innerJoin(billableItems, eq(billableItems.id, stockItems.billableItemId))
    .where(inArray(stockItems.id, itemIds))).map(i => [i.id, i]));
  const named = (storeId: string, stockItemId: string) => {
    const item = items.get(stockItemId)!;
    return { storeId, storeName: storeNames.get(storeId)!, stockItemId, code: item.code, name: item.name, baseUnit: item.baseUnit };
  };

  const dated = batches.map((b): AlertedBatch => ({
    ...named(b.storeId, b.stockItemId),
    batchId: b.batchId,
    batchNumber: b.batchNumber,
    expiresOn: b.expiresOn!,
    daysLeft: daysBetween(today, b.expiresOn!),
    onHand: Number(b.onHand),
  }));
  const belowReorder = low
    .map((l): AlertedItem => ({ ...named(l.storeId, l.stockItemId), onHand: Number(l.onHand), reorderLevel: l.level, inTransit: Number(l.inTransit) }))
    .sort((a, b) => a.storeName.localeCompare(b.storeName) || a.storeId.localeCompare(b.storeId) || a.code.localeCompare(b.code));
  return { expired: dated.filter(b => b.daysLeft < 0), expiring: dated.filter(b => b.daysLeft >= 0), belowReorder };
}
