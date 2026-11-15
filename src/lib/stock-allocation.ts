import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { stockBatches, stockItems, stockMovements } from "@/db/schema";

import { lockBatches } from "./stock-levels";

/**
 * Choosing the batches stock is taken from in a store (P4 slice 2, and
 * dispensing after it): earliest expiry first, never an expired batch
 * (P4 questions 6 and 8), unless the caller names the batches itself.
 *
 * Every batch the item has in the store is locked first, in the lock
 * order (lib/stock-levels.ts), and its balance read after the lock, so two
 * takings from one batch queue rather than both seeing what only one can
 * have.
 */

export interface TakeLine {
  stockItemId: string;
  /** How many base units, chosen earliest expiry first; or `batches`, chosen by hand. */
  quantity?: number;
  batches?: { batchId: string; quantity: number }[];
}

export interface Taken {
  stockItemId: string;
  batchId: string;
  quantity: number;
}

export type AllocationErrorCode = "item_not_found" | "batch_not_found" | "batch_expired" | "not_enough_stock";

export class AllocationError extends Error {
  constructor(readonly code: AllocationErrorCode, readonly line: number) {
    super(`Line ${line}: ${{
      item_not_found: "That is not a stock item of this facility",
      batch_not_found: "That batch is not this item's, or is not in this store",
      batch_expired: "That batch has expired; expired stock is never moved or dispensed, only written off",
      not_enough_stock: "The store does not hold that much of it in date",
    }[code]}`);
    this.name = "AllocationError";
  }
}

interface Held {
  batchId: string;
  stockItemId: string;
  expiresOn: string | null;
  onHand: number;
}

/**
 * The items' batches that have been in the store, locked, earliest expiry
 * first. Empty ones are kept, so naming one is refused as too little stock
 * rather than as not there.
 */
async function heldBatches(tx: AppDb, facilityId: string, storeId: string, stockItemIds: string[]): Promise<Held[]> {
  const candidates = await tx
    .selectDistinct({ id: stockBatches.id })
    .from(stockMovements)
    .innerJoin(stockBatches, eq(stockBatches.id, stockMovements.batchId))
    .where(and(eq(stockMovements.storeId, storeId), inArray(stockBatches.stockItemId, stockItemIds)));
  if (candidates.length === 0)
    return [];
  await lockBatches(tx, facilityId, candidates.map(c => c.id));

  const onHand = sql<string>`sum(${stockMovements.quantity})`;
  const rows = await tx
    .select({ batchId: stockBatches.id, stockItemId: stockBatches.stockItemId, expiresOn: stockBatches.expiresOn, onHand })
    .from(stockMovements)
    .innerJoin(stockBatches, eq(stockBatches.id, stockMovements.batchId))
    .where(and(eq(stockMovements.storeId, storeId), inArray(stockBatches.id, candidates.map(c => c.id))))
    .groupBy(stockBatches.id)
    .orderBy(sql`${stockBatches.expiresOn} ASC NULLS LAST`, asc(stockBatches.createdAt), asc(stockBatches.id));
  return rows.map(r => ({ ...r, onHand: Number(r.onHand) }));
}

function pickEarliest(line: TakeLine, number: number, held: Held[], today: string): Taken[] {
  let wanted = line.quantity!;
  const taken: Taken[] = [];
  for (const batch of held) {
    if (wanted === 0)
      break;
    if (batch.onHand <= 0 || batch.stockItemId !== line.stockItemId || (batch.expiresOn !== null && batch.expiresOn < today))
      continue;
    const quantity = Math.min(wanted, batch.onHand);
    taken.push({ stockItemId: line.stockItemId, batchId: batch.batchId, quantity });
    wanted -= quantity;
  }
  if (wanted > 0)
    throw new AllocationError("not_enough_stock", number);
  return taken;
}

function pickNamed(line: TakeLine, number: number, held: Map<string, Held>, today: string): Taken[] {
  return line.batches!.map((named) => {
    const batch = held.get(named.batchId.toLowerCase());
    if (!batch || batch.stockItemId !== line.stockItemId)
      throw new AllocationError("batch_not_found", number);
    if (batch.expiresOn !== null && batch.expiresOn < today)
      throw new AllocationError("batch_expired", number);
    if (batch.onHand < named.quantity)
      throw new AllocationError("not_enough_stock", number);
    return { stockItemId: line.stockItemId, batchId: batch.batchId, quantity: named.quantity };
  });
}

/**
 * The batches each line takes from the store, with how much of each, line by
 * line. Refuses a line the store cannot fill from stock in date, naming the
 * line. Lines of one item draw on its batches in turn, never counting a
 * unit twice.
 */
export async function allocate(tx: AppDb, facilityId: string, storeId: string, given: TakeLine[], today: string): Promise<Taken[][]> {
  const lines = given.map(l => ({ ...l, stockItemId: l.stockItemId.toLowerCase() }));
  const ids = [...new Set(lines.map(l => l.stockItemId))].sort();
  const known = new Set((await tx.select({ id: stockItems.id }).from(stockItems).where(inArray(stockItems.id, ids)).orderBy(asc(stockItems.id)).for("share")).map(i => i.id));
  const held = await heldBatches(tx, facilityId, storeId, ids);
  const heldOf = new Map(held.map(b => [b.batchId, b]));

  const taken: Taken[][] = [];
  for (const [index, line] of lines.entries()) {
    if (!known.has(line.stockItemId))
      throw new AllocationError("item_not_found", index + 1);
    const picked = line.batches ? pickNamed(line, index + 1, heldOf, today) : pickEarliest(line, index + 1, held, today);
    for (const p of picked)
      heldOf.get(p.batchId)!.onHand -= p.quantity;
    taken.push(picked);
  }
  return taken;
}
