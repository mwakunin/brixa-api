import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { billableItems, reorderLevels, stockItems, stores } from "@/db/schema";

import type { PatientActor } from "./patients";

import { recordAudit } from "./audit";
import { isUniqueViolation } from "./db-errors";

/**
 * The places stock is kept (SCHEMA.md §8, P4 slice 1a): the main store, the
 * pharmacy, and ward and other sub-stores, each with a reorder level per
 * item. What a store holds is derived from its movements (slice 1b).
 */

type StoreRow = typeof stores.$inferSelect;
export type StoreKind = StoreRow["kind"];

export type StoreErrorCode = "not_found" | "name_taken" | "item_not_found";

export class StoreError extends Error {
  constructor(readonly code: StoreErrorCode) {
    super({
      not_found: "No such store",
      name_taken: "Another store has that name",
      item_not_found: "One of these is not a stock item of this facility",
    }[code]);
    this.name = "StoreError";
  }
}

async function insertOrRefuse(tx: AppDb, write: () => Promise<StoreRow[]>): Promise<StoreRow> {
  try {
    const [store] = await write();
    return store;
  }
  catch (err) {
    if (isUniqueViolation(err))
      throw new StoreError("name_taken");
    throw err;
  }
}

export async function createStore(tx: AppDb, facilityId: string, input: { name: string; kind: StoreKind }, actor: PatientActor): Promise<StoreRow> {
  const store = await insertOrRefuse(tx, () => tx.insert(stores).values({ facilityId, ...input }).returning());
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "store.created",
    entityType: "store",
    entityId: store.id,
    summary: `Created store ${store.name}`,
    detail: { kind: store.kind },
  });
  return store;
}

/** Renames a store, or retires it or brings it back. Its kind is fixed. */
export async function updateStore(
  tx: AppDb,
  facilityId: string,
  id: string,
  input: { name?: string; isActive?: boolean },
  actor: PatientActor,
): Promise<StoreRow> {
  const [current] = await tx.select().from(stores).where(eq(stores.id, id)).for("update").limit(1);
  if (!current)
    throw new StoreError("not_found");
  const store = await insertOrRefuse(tx, () => tx.update(stores).set(input).where(eq(stores.id, id)).returning());

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "store.updated",
    entityType: "store",
    entityId: id,
    summary: `Updated store ${store.name}`,
    detail: {
      before: { name: current.name, isActive: current.isActive },
      after: { name: store.name, isActive: store.isActive },
    },
  });
  return store;
}

export interface ShownStore {
  id: string;
  name: string;
  kind: StoreKind;
  isActive: boolean;
}

/** Every store, by name. Not patient data, so not audited. */
export async function listStores(tx: AppDb, filter: { id?: string } = {}): Promise<ShownStore[]> {
  return tx
    .select({ id: stores.id, name: stores.name, kind: stores.kind, isActive: stores.isActive })
    .from(stores)
    .where(filter.id ? eq(stores.id, filter.id) : undefined)
    .orderBy(asc(stores.name));
}

export async function storeShown(tx: AppDb, id: string): Promise<ShownStore> {
  const [store] = await listStores(tx, { id });
  if (!store)
    throw new StoreError("not_found");
  return store;
}

export interface ShownReorderLevel {
  stockItemId: string;
  code: string;
  name: string;
  baseUnit: string;
  /** In the item's base unit. */
  level: number;
}

/** A store's reorder levels, by item code. Zero flags nothing. */
export async function reorderLevelsOf(tx: AppDb, storeId: string): Promise<ShownReorderLevel[]> {
  await storeShown(tx, storeId);
  return tx
    .select({ stockItemId: reorderLevels.stockItemId, code: billableItems.code, name: billableItems.name, baseUnit: stockItems.baseUnit, level: reorderLevels.level })
    .from(reorderLevels)
    .innerJoin(stockItems, eq(stockItems.id, reorderLevels.stockItemId))
    .innerJoin(billableItems, eq(billableItems.id, stockItems.billableItemId))
    .where(eq(reorderLevels.storeId, storeId))
    .orderBy(asc(billableItems.code));
}

/**
 * Sets the given items' reorder levels in one store, leaving its others as
 * they are. Each change is audited with its old and new level.
 */
export async function setReorderLevels(
  tx: AppDb,
  facilityId: string,
  storeId: string,
  levels: readonly { stockItemId: string; level: number }[],
  actor: PatientActor,
): Promise<ShownReorderLevel[]> {
  // Locked, so two changes to one store's levels at once each audit what they replaced.
  const [store] = await tx.select({ id: stores.id, name: stores.name }).from(stores).where(eq(stores.id, storeId)).for("update").limit(1);
  if (!store)
    throw new StoreError("not_found");

  const ids = levels.map(l => l.stockItemId);
  const found = await tx.select({ id: stockItems.id }).from(stockItems).where(inArray(stockItems.id, ids));
  if (found.length !== new Set(ids).size)
    throw new StoreError("item_not_found");

  const current = await tx
    .select({ stockItemId: reorderLevels.stockItemId, level: reorderLevels.level })
    .from(reorderLevels)
    .where(and(eq(reorderLevels.storeId, storeId), inArray(reorderLevels.stockItemId, ids)));
  const before = new Map(current.map(r => [r.stockItemId, r.level]));
  const changes = levels
    .filter(l => before.get(l.stockItemId) !== l.level)
    .map(l => ({ stockItemId: l.stockItemId, before: before.get(l.stockItemId) ?? null, after: l.level }));

  if (changes.length > 0) {
    await tx.insert(reorderLevels)
      .values(changes.map(c => ({ facilityId, storeId, stockItemId: c.stockItemId, level: c.after })))
      .onConflictDoUpdate({
        target: [reorderLevels.facilityId, reorderLevels.storeId, reorderLevels.stockItemId],
        set: { level: sql`excluded.level` },
      });
    await recordAudit(tx, {
      facilityId,
      actorId: actor.userId,
      action: "reorder_levels.set",
      entityType: "store",
      entityId: storeId,
      summary: `Set ${changes.length} reorder level${changes.length === 1 ? "" : "s"} in ${store.name}`,
      detail: { changes },
    });
  }
  return reorderLevelsOf(tx, storeId);
}
