import { and, asc, eq, ne } from "drizzle-orm";

import type { AppDb } from "@/db";
import type { MembershipRole } from "@/db/schema";

import { billableItems, drugCatalogue, stockItems } from "@/db/schema";

import type { PatientActor } from "./patients";

import { recordAudit } from "./audit";
import { isUniqueViolation, pgConstraintName } from "./db-errors";
import { itemOnHand } from "./stock-levels";

/**
 * What the facility stocks (SCHEMA.md §8, P4 slice 1a): each a `drug` or
 * `consumable` billable item with stock details. Its code, name and price
 * are the item's, so a dispense is charged at the price the price list sets
 * (rule 21) and the shelf and the bill never disagree.
 *
 * Counted in a base unit with a pack size (decided 2026-11-15, per tablet).
 * The base unit and the drug are fixed once set; a different unit is a new
 * stock item. Every stock item of one controlled drug is counted in the same
 * unit, so its register, kept per drug, adds like for like
 * (`stock_items_one_unit_per_drug`, migration 0100). Another drug may be
 * stocked in two (bottles, and loose mL), as dispensing allows.
 */

type StockItemRow = typeof stockItems.$inferSelect;

/** Who sets up stores, stock items and reorder levels. Not clinical acts, so no licence is asked. */
export const STOCK_KEEPERS = ["facility_admin", "pharmacist", "storekeeper"] as const satisfies readonly MembershipRole[];

export type StockItemErrorCode
  = | "not_found"
    | "not_a_stock_item"
    | "already_a_stock_item"
    | "drug_needed"
    | "not_a_drug_item"
    | "drug_not_found"
    | "base_unit_differs"
    | "holds_stock";

export class StockItemError extends Error {
  /** `unit`: the drug's base unit here, for `base_unit_differs`. */
  constructor(readonly code: StockItemErrorCode, unit?: string) {
    super({
      not_found: "No such stock item",
      not_a_stock_item: "That item is not an active drug or consumable item",
      already_a_stock_item: "That item is already a stock item",
      drug_needed: "A drug item names the catalogue drug it is",
      not_a_drug_item: "A consumable names no catalogue drug; only a drug item does",
      drug_not_found: "No such drug in the catalogue, or it is retired",
      base_unit_differs: `This controlled drug is counted in ${unit ?? "another unit"} here: count this item in it too, so its register adds like for like`,
      holds_stock: "Some of this item is still in stock; use it up, move it or write it off before retiring the item",
    }[code]);
    this.name = "StockItemError";
  }
}

export interface StockItemInput {
  billableItemId: string;
  /** The catalogue drug; required for a `drug` item, refused for a consumable. */
  drugCode?: string | null;
  baseUnit: string;
  packSize: number;
}

/** Sets up a stock item on an active `drug` or `consumable` billable item. */
export async function createStockItem(tx: AppDb, facilityId: string, input: StockItemInput, actor: PatientActor): Promise<StockItemRow> {
  const [item] = await tx.select().from(billableItems).where(eq(billableItems.id, input.billableItemId)).limit(1);
  if (!item || !item.isActive || (item.category !== "drug" && item.category !== "consumable"))
    throw new StockItemError("not_a_stock_item");

  const drugCode = input.drugCode ?? null;
  if (item.category === "drug" && !drugCode)
    throw new StockItemError("drug_needed");
  if (item.category === "consumable" && drugCode)
    throw new StockItemError("not_a_drug_item");
  if (drugCode) {
    const [drug] = await tx.select({ retiredAt: drugCatalogue.retiredAt, controlledSchedule: drugCatalogue.controlledSchedule }).from(drugCatalogue).where(eq(drugCatalogue.code, drugCode)).limit(1);
    if (!drug || drug.retiredAt)
      throw new StockItemError("drug_not_found");
    const [other] = drug.controlledSchedule
      ? await tx.select({ baseUnit: stockItems.baseUnit }).from(stockItems).where(and(eq(stockItems.drugCode, drugCode), ne(stockItems.baseUnit, input.baseUnit))).limit(1)
      : [];
    if (other)
      throw new StockItemError("base_unit_differs", other.baseUnit);
  }

  let stockItem: StockItemRow;
  try {
    [stockItem] = await tx.insert(stockItems).values({
      facilityId,
      billableItemId: item.id,
      drugCode,
      baseUnit: input.baseUnit,
      packSize: input.packSize,
    }).returning();
  }
  catch (err) {
    if (isUniqueViolation(err))
      throw new StockItemError("already_a_stock_item");
    // Another item of the controlled drug, in another unit, set up meanwhile.
    if (pgConstraintName(err) === "stock_items_one_unit_per_drug")
      throw new StockItemError("base_unit_differs");
    throw err;
  }

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "stock_item.created",
    entityType: "stock_item",
    entityId: stockItem.id,
    summary: `Set up stock item ${item.code} ${item.name}`,
    detail: { code: item.code, drugCode, baseUnit: stockItem.baseUnit, packSize: stockItem.packSize },
  });
  return stockItem;
}

/** Changes a stock item's pack size, or retires it or brings it back. An item still in stock stays open. */
export async function updateStockItem(
  tx: AppDb,
  facilityId: string,
  id: string,
  input: { packSize?: number; isActive?: boolean },
  actor: PatientActor,
): Promise<StockItemRow> {
  const [current] = await tx.select().from(stockItems).where(eq(stockItems.id, id)).for("update").limit(1);
  if (!current)
    throw new StockItemError("not_found");
  // The row lock queues this behind any delivery of it still going in (it holds the item shared).
  if (input.isActive === false && current.isActive && await itemOnHand(tx, id) > 0)
    throw new StockItemError("holds_stock");
  const [updated] = await tx.update(stockItems).set(input).where(eq(stockItems.id, id)).returning();

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "stock_item.updated",
    entityType: "stock_item",
    entityId: id,
    summary: "Updated a stock item",
    detail: {
      before: { packSize: current.packSize, isActive: current.isActive },
      after: { packSize: updated.packSize, isActive: updated.isActive },
    },
  });
  return updated;
}

export interface ShownDrug {
  code: string;
  genericName: string;
  strength: string;
  form: string;
  doseUnit: string;
  controlledSchedule: "I" | "II" | "III" | "IV" | null;
}

export interface ShownStockItem {
  id: string;
  billableItemId: string;
  /** The billable item's code and name. */
  code: string;
  name: string;
  category: "drug" | "consumable";
  /** The catalogue drug, for a drug item. */
  drug: ShownDrug | null;
  baseUnit: string;
  packSize: number;
  isActive: boolean;
}

/** The facility's stock items, by code. Not patient data, so not audited. */
export async function listStockItems(tx: AppDb, filter: { id?: string; drugCode?: string } = {}): Promise<ShownStockItem[]> {
  const rows = await tx
    .select({ stockItem: stockItems, code: billableItems.code, name: billableItems.name, category: billableItems.category, drug: drugCatalogue })
    .from(stockItems)
    .innerJoin(billableItems, eq(billableItems.id, stockItems.billableItemId))
    .leftJoin(drugCatalogue, eq(drugCatalogue.code, stockItems.drugCode))
    .where(and(
      filter.id ? eq(stockItems.id, filter.id) : undefined,
      filter.drugCode ? eq(stockItems.drugCode, filter.drugCode) : undefined,
    ))
    .orderBy(asc(billableItems.code));

  return rows.map(({ stockItem, code, name, category, drug }) => ({
    id: stockItem.id,
    billableItemId: stockItem.billableItemId,
    code,
    name,
    // Set up only on these two categories, and an item's category never changes.
    category: category as "drug" | "consumable",
    drug: drug
      ? { code: drug.code, genericName: drug.genericName, strength: drug.strength, form: drug.form, doseUnit: drug.doseUnit, controlledSchedule: drug.controlledSchedule }
      : null,
    baseUnit: stockItem.baseUnit,
    packSize: stockItem.packSize,
    isActive: stockItem.isActive,
  }));
}

/** One stock item as the list shows it. */
export async function stockItemShown(tx: AppDb, id: string): Promise<ShownStockItem> {
  const [item] = await listStockItems(tx, { id });
  if (!item)
    throw new StockItemError("not_found");
  return item;
}
