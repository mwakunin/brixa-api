import { asc, eq, gt, inArray, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { billableItems, reorderLevels, stockBatches, stockItems, stockMovements } from "@/db/schema";

import { businessDate } from "./dates";

/**
 * What a store holds (SCHEMA.md §8, P4 slice 1b): the sum of its movements
 * per batch, never stored (rule 4) and never negative.
 *
 * **Lock order for stock:** store, then stock items (by id), then batches
 * (by id). A batch row is written once, so it is locked with a transaction
 * advisory lock rather than a row lock, which would need a privilege to
 * update it. Whatever takes stock from a batch takes this lock first and
 * reads the balance after it.
 */

/** Serialises everything that changes these batches' stock until the transaction ends. Sorted, so two callers never wait on each other in a cycle. */
export async function lockBatches(tx: AppDb, facilityId: string, batchIds: readonly string[]): Promise<void> {
  for (const id of [...new Set(batchIds)].sort())
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`stock_batch:${facilityId}:${id}`}, 0))`);
}

/** Base units of the item on hand across every store. */
export async function itemOnHand(tx: AppDb, stockItemId: string): Promise<number> {
  const [{ onHand }] = await tx
    .select({ onHand: sql<string>`coalesce(sum(${stockMovements.quantity}), 0)` })
    .from(stockMovements)
    .innerJoin(stockBatches, eq(stockBatches.id, stockMovements.batchId))
    .where(eq(stockBatches.stockItemId, stockItemId));
  return Number(onHand);
}

/** Base units of anything on hand in the store. */
export async function storeOnHand(tx: AppDb, storeId: string): Promise<number> {
  const [{ onHand }] = await tx
    .select({ onHand: sql<string>`coalesce(sum(${stockMovements.quantity}), 0)` })
    .from(stockMovements)
    .where(eq(stockMovements.storeId, storeId));
  return Number(onHand);
}

export interface ShownBatchStock {
  batchId: string;
  batchNumber: string | null;
  expiresOn: string | null;
  /** Its last day has passed: it is never dispensed (P4 question 6), and waits to be written off. */
  expired: boolean;
  onHand: number;
  /** At the batch's own cost, rounded to the cent here and nowhere earlier (question 2). */
  valueCents: number;
}

export interface ShownItemStock {
  stockItemId: string;
  code: string;
  name: string;
  baseUnit: string;
  packSize: number;
  onHand: number;
  valueCents: number;
  /** This store's, if one is set. */
  reorderLevel: number | null;
  /** Earliest expiry first, those without one last: the order they are used in. */
  batches: ShownBatchStock[];
}

/**
 * A store's stock: each item it holds or has a reorder level for, by code,
 * with its batches that hold any. Not patient data, so not audited.
 */
export async function storeStock(tx: AppDb, storeId: string, today = businessDate()): Promise<ShownItemStock[]> {
  const onHand = sql<string>`sum(${stockMovements.quantity})`;
  const batches = await tx
    .select({
      batchId: stockBatches.id,
      stockItemId: stockBatches.stockItemId,
      batchNumber: stockBatches.batchNumber,
      expiresOn: stockBatches.expiresOn,
      onHand,
      valueCents: sql<string>`round(${onHand} * ${stockBatches.totalCostCents}::numeric / ${stockBatches.quantityReceived})`,
    })
    .from(stockMovements)
    .innerJoin(stockBatches, eq(stockBatches.id, stockMovements.batchId))
    .where(eq(stockMovements.storeId, storeId))
    .groupBy(stockBatches.id)
    .having(gt(onHand, sql`0`))
    .orderBy(sql`${stockBatches.expiresOn} ASC NULLS LAST`, asc(stockBatches.createdAt));

  const levels = await tx
    .select({ stockItemId: reorderLevels.stockItemId, level: reorderLevels.level })
    .from(reorderLevels)
    .where(eq(reorderLevels.storeId, storeId));

  const itemIds = [...new Set([...batches.map(b => b.stockItemId), ...levels.map(l => l.stockItemId)])];
  if (itemIds.length === 0)
    return [];
  const items = await tx
    .select({ id: stockItems.id, code: billableItems.code, name: billableItems.name, baseUnit: stockItems.baseUnit, packSize: stockItems.packSize })
    .from(stockItems)
    .innerJoin(billableItems, eq(billableItems.id, stockItems.billableItemId))
    .where(inArray(stockItems.id, itemIds))
    .orderBy(asc(billableItems.code));

  const batchesOf = Map.groupBy(batches, b => b.stockItemId);
  const levelOf = new Map(levels.map(l => [l.stockItemId, l.level]));
  return items.map((item) => {
    const held = (batchesOf.get(item.id) ?? []).map(b => ({
      batchId: b.batchId,
      batchNumber: b.batchNumber,
      expiresOn: b.expiresOn,
      expired: b.expiresOn !== null && b.expiresOn < today,
      onHand: Number(b.onHand),
      valueCents: Number(b.valueCents),
    }));
    return {
      stockItemId: item.id,
      code: item.code,
      name: item.name,
      baseUnit: item.baseUnit,
      packSize: item.packSize,
      onHand: held.reduce((sum, b) => sum + b.onHand, 0),
      valueCents: held.reduce((sum, b) => sum + b.valueCents, 0),
      reorderLevel: levelOf.get(item.id) ?? null,
      batches: held,
    };
  });
}
