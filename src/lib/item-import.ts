import { and, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { billableItems, controlledDrugRegister, drugCatalogue, priceChangeLines, priceChanges, stockItems } from "@/db/schema";

import type { DrugMatch } from "./drug-catalogue";
import type { PatientActor } from "./patients";

import { recordAudit } from "./audit";
import { businessDate } from "./dates";
import { isUniqueViolation, pgConstraintName } from "./db-errors";
import { DRUG_CODE_SHAPE, searchDrugs } from "./drug-catalogue";
import { DrugFileError, parseCsv } from "./drug-catalogue-load";
import { cashPriceList, listBillableItems, PriceError, requestPriceChange } from "./prices";

/**
 * A facility's drug and consumable list, loaded from a CSV (SPEC.md §7.4,
 * P4 slice 1c, decided 2026-11-15), so a hospital is not set up by hand.
 *
 * Previewed first, writing nothing; imported whole or not at all. Each row
 * becomes a billable item and its stock item, and the file's prices one
 * price change for a second person to approve (rule 24). Running a file
 * again changes nothing; a row that disagrees with what is set up is
 * refused, never applied.
 */

export const IMPORT_HEADER = ["code", "name", "category", "drug_code", "base_unit", "pack_size", "unit_price"] as const;
export const MAX_IMPORT_ROWS = 5000;
/** Drug rows given suggestions in one preview: each costs a search. */
export const MAX_SUGGESTED_ROWS = 200;
const SUGGESTIONS = 3;

/** As `billable_items_code_shape`, and the item route's own check. */
const ITEM_CODE_SHAPE = /^[A-Z0-9][A-Z0-9./-]{0,23}$/;
/** Shillings, at most two decimals, below KES 10 million a unit. */
const PRICE_SHAPE = /^\d{1,7}(?:\.\d{1,2})?$/;
const MAX_PACK_SIZE = 1_000_000;

export class ItemImportError extends Error {
  constructor(readonly code: "unreadable" | "has_problems" | "changed_meanwhile", message: string, readonly rows?: PlannedRow[], options?: ErrorOptions) {
    super(message, options);
    this.name = "ItemImportError";
  }
}

export interface PlannedRow {
  /** Its record in the file, the header being 1. */
  row: number;
  code: string;
  name: string;
  /**
   * What importing does with it: a new item and stock item, a stock item on
   * an item already there, or nothing. Null while it has problems.
   */
  action: "create" | "add_stock_item" | "unchanged" | null;
  /** The cash price to request, when it differs from today's and none waiting for approval asks for it. */
  requestedPriceCents: number | null;
  problems: string[];
  /** For a drug row naming no catalogue drug: what its name suggests. */
  suggestions: Pick<DrugMatch, "code" | "genericName" | "strength" | "form">[];
}

interface ParsedRow {
  row: number;
  code: string;
  name: string;
  category: string;
  drugCode: string | null;
  baseUnit: string;
  packSize: number | null;
  priceCents: number | null;
  problems: string[];
}

function priceCentsOf(text: string): number {
  const [whole, fraction = ""] = text.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

function parseRow(fields: string[], row: number): ParsedRow {
  const [code = "", name = "", category = "", drugCode = "", baseUnit = "", packSize = "", price = ""] = fields.map(f => f.trim());
  const parsed: ParsedRow = {
    row,
    code: code.toUpperCase(),
    name,
    category,
    drugCode: drugCode === "" ? null : drugCode.toUpperCase(),
    baseUnit,
    packSize: /^\d+$/.test(packSize) ? Number(packSize) : null,
    priceCents: PRICE_SHAPE.test(price) ? priceCentsOf(price) : null,
    problems: [],
  };
  const problem = (text: string) => parsed.problems.push(text);

  if (fields.length !== IMPORT_HEADER.length)
    problem(`has ${fields.length} fields, not ${IMPORT_HEADER.length}`);
  if (!ITEM_CODE_SHAPE.test(parsed.code))
    problem("code: letters, digits and . / - only, up to 24");
  if (name.length < 2 || name.length > 120 || /\p{C}/u.test(name))
    problem("name: 2 to 120 characters on one line");
  if (category !== "drug" && category !== "consumable")
    problem("category: drug or consumable");
  if (category === "consumable" && parsed.drugCode)
    problem("drug_code: a consumable names no catalogue drug");
  if (parsed.drugCode && !DRUG_CODE_SHAPE.test(parsed.drugCode))
    problem("drug_code: not a catalogue code");
  if (baseUnit.length < 1 || baseUnit.length > 20 || /\p{C}/u.test(baseUnit))
    problem("base_unit: 1 to 20 characters, e.g. tablet, mL, vial, pair");
  if (parsed.packSize === null || parsed.packSize < 1 || parsed.packSize > MAX_PACK_SIZE)
    problem(`pack_size: a whole number from 1 to ${MAX_PACK_SIZE.toLocaleString("en")}`);
  if (price !== "" && parsed.priceCents === null)
    problem("unit_price: shillings, at most two decimals (2.50), or empty for none yet");
  return parsed;
}

function readFile(csv: string): ParsedRow[] {
  let records: string[][];
  try {
    records = parseCsv(csv);
  }
  catch (err) {
    if (err instanceof DrugFileError)
      throw new ItemImportError("unreadable", `The file cannot be read: ${err.message.replace(/^Not a usable drug catalogue file: /, "")}`);
    throw err;
  }
  const [header, ...rows] = records;
  if (!header || header.map(h => h.trim().toLowerCase()).join(",") !== IMPORT_HEADER.join(","))
    throw new ItemImportError("unreadable", `The header must be ${IMPORT_HEADER.join(",")}`);
  if (rows.length === 0)
    throw new ItemImportError("unreadable", "The file has no items");
  if (rows.length > MAX_IMPORT_ROWS)
    throw new ItemImportError("unreadable", `A file holds at most ${MAX_IMPORT_ROWS.toLocaleString("en")} items; split it`);
  return rows.map((fields, i) => parseRow(fields, i + 2));
}

/** The first word of a name long enough to search the catalogue by: "Paracetamol 500mg tabs" gives "Paracetamol". */
function searchWordOf(name: string): string | null {
  return name.match(/\p{L}{3,}/u)?.[0] ?? null;
}

/** Marks each row whose code an earlier row already has. */
function markDuplicates(rows: ParsedRow[]): void {
  const seen = new Map<string, number>();
  for (const r of rows) {
    const first = seen.get(r.code);
    if (first !== undefined)
      r.problems.push(`code ${r.code} is also on row ${first}`);
    else
      seen.set(r.code, r.row);
  }
}

type ListedItem = Awaited<ReturnType<typeof listBillableItems>>[number];
type StockItemRow = typeof stockItems.$inferSelect;

/** What the facility already has that the file's rows name, read once. */
interface Snapshot {
  /** By code, each with its cash price on the day the file's prices would start. */
  items: Map<string, ListedItem>;
  stockOf: Map<string, StockItemRow>;
  /** `item:price` for each pending cash price that would be in force by then. */
  pending: Set<string>;
  currentDrugs: Set<string>;
  /** The base unit of each drug kept on the controlled-drug register: an item's already set up, else the first row naming it (`row`). */
  drugUnits: Map<string, { unit: string; row: number | null }>;
}

async function pendingPrices(tx: AppDb, ids: string[], today: string, effectiveFrom: string): Promise<Set<string>> {
  if (ids.length === 0)
    return new Set();
  const lines = await tx
    .select({ billableItemId: priceChangeLines.billableItemId, unitPriceCents: priceChangeLines.unitPriceCents })
    .from(priceChangeLines)
    .innerJoin(priceChanges, eq(priceChanges.id, priceChangeLines.priceChangeId))
    .where(and(
      eq(priceChanges.status, "pending"),
      eq(priceChanges.priceListId, await cashPriceList(tx)),
      inArray(priceChangeLines.billableItemId, ids),
      // Approvable (one already past its day never can be), and starting by the day asked for.
      gte(priceChanges.effectiveFrom, today),
      lte(priceChanges.effectiveFrom, effectiveFrom),
    ));
  return new Set(lines.map(l => `${l.billableItemId}:${l.unitPriceCents}`));
}

/**
 * The unit each drug kept on the controlled-drug register is counted in: as
 * set up here, or as the file first gives it. Its register adds every item
 * of it, while it is scheduled and after, once a page is open (migrations
 * 0100 and 0103).
 */
async function drugUnitsOf(tx: AppDb, rows: ParsedRow[], drugCodes: string[]): Promise<Snapshot["drugUnits"]> {
  const controlled = new Set(drugCodes.length === 0
    ? []
    : [
        ...await tx.select({ code: drugCatalogue.code }).from(drugCatalogue).where(and(inArray(drugCatalogue.code, drugCodes), isNotNull(drugCatalogue.controlledSchedule))),
        ...await tx.selectDistinct({ code: controlledDrugRegister.drugCode }).from(controlledDrugRegister).where(inArray(controlledDrugRegister.drugCode, drugCodes)),
      ].map(d => d.code));
  const units: Snapshot["drugUnits"] = new Map(controlled.size === 0
    ? []
    : (await tx.select({ drugCode: stockItems.drugCode, baseUnit: stockItems.baseUnit }).from(stockItems).where(inArray(stockItems.drugCode, [...controlled]))).map(s => [s.drugCode!, { unit: s.baseUnit, row: null }]));
  for (const r of rows) {
    if (r.drugCode && controlled.has(r.drugCode) && !units.has(r.drugCode))
      units.set(r.drugCode, { unit: r.baseUnit, row: r.row });
  }
  return units;
}

async function loadSnapshot(tx: AppDb, rows: ParsedRow[], today: string, effectiveFrom: string): Promise<Snapshot> {
  const codes = new Set(rows.map(r => r.code));
  const items = new Map((await listBillableItems(tx, effectiveFrom)).filter(i => codes.has(i.code)).map(i => [i.code, i]));
  const ids = [...items.values()].map(i => i.id);
  const stockOf = new Map(ids.length === 0
    ? []
    : (await tx.select().from(stockItems).where(inArray(stockItems.billableItemId, ids))).map(s => [s.billableItemId, s]));
  const drugCodes = [...new Set(rows.map(r => r.drugCode).filter((c): c is string => c !== null))];
  const currentDrugs = new Set(drugCodes.length === 0
    ? []
    : (await tx.select({ code: drugCatalogue.code }).from(drugCatalogue).where(and(inArray(drugCatalogue.code, drugCodes), isNull(drugCatalogue.retiredAt)))).map(d => d.code));
  return { items, stockOf, pending: await pendingPrices(tx, ids, today, effectiveFrom), currentDrugs, drugUnits: await drugUnitsOf(tx, rows, drugCodes) };
}

/** Where a row disagrees with what is already set up under its code. */
function disagreements(r: ParsedRow, item: ListedItem | undefined, stock: StockItemRow | undefined): string[] {
  const problems: string[] = [];
  if (item && item.category !== r.category)
    problems.push(`code ${r.code} is already a ${item.category} item`);
  if (item && !item.isActive)
    problems.push(`code ${r.code} is a retired item`);
  if (stock && stock.drugCode !== r.drugCode)
    problems.push(`code ${r.code} is already stocked as ${stock.drugCode ?? "a consumable"}`);
  if (stock && stock.baseUnit !== r.baseUnit)
    problems.push(`code ${r.code} is already counted in ${stock.baseUnit}`);
  if (stock && stock.packSize !== r.packSize)
    problems.push(`code ${r.code} already comes in packs of ${stock.packSize}; change it on the item`);
  return problems;
}

/**
 * One row's plan. A price is asked for only if it differs from the item's
 * price on the day the file's prices start, and no pending change already
 * asks for it by then.
 */
function planRow(r: ParsedRow, snapshot: Snapshot): PlannedRow {
  const problems = [...r.problems];
  if (r.category === "drug" && !r.drugCode)
    problems.push("drug_code: needed for a drug; choose its catalogue drug");
  if (r.drugCode && DRUG_CODE_SHAPE.test(r.drugCode) && !snapshot.currentDrugs.has(r.drugCode))
    problems.push(`drug_code: ${r.drugCode} is not a current catalogue drug`);

  const item = snapshot.items.get(r.code);
  const stock = item ? snapshot.stockOf.get(item.id) : undefined;
  problems.push(...disagreements(r, item, stock));
  // A new stock item counts a drug on the register as the others do.
  const counted = !stock && r.drugCode ? snapshot.drugUnits.get(r.drugCode) : undefined;
  if (counted && counted.unit !== r.baseUnit)
    problems.push(counted.row === null ? `base_unit: ${r.drugCode} is kept on the controlled-drug register, and already counted in ${counted.unit} by another item` : `base_unit: ${r.drugCode} is kept on the controlled-drug register, and counted in ${counted.unit} on row ${counted.row}`);

  const priceDiffers = r.priceCents !== null && r.priceCents !== (item?.cashPriceCents ?? null)
    && !(item && snapshot.pending.has(`${item.id}:${r.priceCents}`));
  return {
    row: r.row,
    code: r.code,
    name: item?.name ?? r.name,
    action: problems.length > 0 ? null : !item ? "create" : !stock ? "add_stock_item" : "unchanged",
    requestedPriceCents: problems.length === 0 && priceDiffers ? r.priceCents : null,
    problems,
    suggestions: [],
  };
}

/** Up to three catalogue drugs for each drug row naming none, for the first `MAX_SUGGESTED_ROWS` of them. */
async function suggestDrugs(tx: AppDb, planned: { planned: PlannedRow; parsed: ParsedRow }[]): Promise<void> {
  const unmatched = planned.filter(p => p.parsed.category === "drug" && !p.parsed.drugCode).slice(0, MAX_SUGGESTED_ROWS);
  for (const p of unmatched) {
    const word = searchWordOf(p.parsed.name);
    if (word)
      p.planned.suggestions = (await searchDrugs(tx, word)).slice(0, SUGGESTIONS).map(d => ({ code: d.code, genericName: d.genericName, strength: d.strength, form: d.form }));
  }
}

export interface ImportOptions {
  /** When the file's prices start, once approved: today unless given, never before. */
  effectiveFrom?: string;
  today?: string;
}

function datesOf(options: ImportOptions): { today: string; effectiveFrom: string } {
  const today = options.today ?? businessDate();
  const effectiveFrom = options.effectiveFrom ?? today;
  // A price change cannot start in the past, so neither can a file's prices.
  if (effectiveFrom < today)
    throw new PriceError("effective_in_past");
  return { today, effectiveFrom };
}

/** Each row's plan, with the fields it was read from. */
async function planRows(tx: AppDb, csv: string, { today, effectiveFrom }: { today: string; effectiveFrom: string }): Promise<{ planned: PlannedRow; parsed: ParsedRow }[]> {
  const rows = readFile(csv);
  markDuplicates(rows);
  const snapshot = await loadSnapshot(tx, rows, today, effectiveFrom);
  const planned = rows.map(r => ({ planned: planRow(r, snapshot), parsed: r }));
  await suggestDrugs(tx, planned);
  return planned;
}

/**
 * What importing the file would do, row by row, with every problem found,
 * its prices compared on the day they would start. Writes nothing. Not
 * patient data, so not audited.
 */
export async function planImport(tx: AppDb, csv: string, options: ImportOptions = {}): Promise<PlannedRow[]> {
  return (await planRows(tx, csv, datesOf(options))).map(p => p.planned);
}

export interface ImportResult {
  created: number;
  stockItemsAdded: number;
  unchanged: number;
  /** The price change awaiting approval; null when no price changed. */
  priceChangeId: string | null;
}

/** Writes the new items and stock items; answers each code's billable item id. */
async function writeItems(tx: AppDb, facilityId: string, rows: { planned: PlannedRow; parsed: ParsedRow }[]): Promise<Map<string, string>> {
  const toCreate = rows.filter(r => r.planned.action === "create");
  const toStock = rows.filter(r => r.planned.action === "create" || r.planned.action === "add_stock_item");
  const codes = new Set(rows.map(r => r.planned.code));
  const idOf = new Map((await listBillableItems(tx)).filter(i => codes.has(i.code)).map(i => [i.code, i.id]));
  try {
    if (toCreate.length > 0) {
      const inserted = await tx.insert(billableItems)
        .values(toCreate.map(({ planned, parsed }) => ({ facilityId, code: planned.code, name: planned.name, category: parsed.category as "drug" | "consumable" })))
        .returning({ id: billableItems.id, code: billableItems.code });
      for (const i of inserted)
        idOf.set(i.code, i.id);
    }
    if (toStock.length > 0) {
      await tx.insert(stockItems).values(toStock.map(({ planned, parsed }) => (
        { facilityId, billableItemId: idOf.get(planned.code)!, drugCode: parsed.drugCode, baseUnit: parsed.baseUnit, packSize: parsed.packSize! }
      )));
    }
  }
  catch (err) {
    // A hand-made item took one of these codes, or counted one of these drugs in another unit, after the plan was read.
    if (isUniqueViolation(err) || pgConstraintName(err) === "stock_items_one_unit_per_drug")
      throw new ItemImportError("changed_meanwhile", "An item in this file was set up by someone else meanwhile; preview it again", undefined, { cause: err });
    throw err;
  }
  return idOf;
}

/**
 * Imports the file: refused whole, with every problem, if any row has one.
 * New items, their stock items and the audit entry commit together; the
 * prices wait in one price change for the finance manager.
 */
export async function importItems(tx: AppDb, facilityId: string, csv: string, actor: PatientActor, options: ImportOptions = {}): Promise<ImportResult> {
  // One import at a time per facility, so a second waits and then sees the first's items and pending prices.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`item_import:${facilityId}`}, 0))`);
  // Read once, after the lock: the prices are compared on the very day they are then asked from.
  const dates = datesOf(options);
  const rows = await planRows(tx, csv, dates);
  const plan = rows.map(r => r.planned);
  const refused = plan.filter(p => p.problems.length > 0);
  if (refused.length > 0)
    throw new ItemImportError("has_problems", `${refused.length} row${refused.length === 1 ? " has" : "s have"} problems; nothing was imported`, refused);

  const idOf = await writeItems(tx, facilityId, rows);
  const priced = plan.filter(p => p.requestedPriceCents !== null);
  const change = priced.length === 0
    ? null
    : await requestPriceChange(tx, facilityId, {
        effectiveFrom: dates.effectiveFrom,
        reason: "Item import",
        lines: priced.map(p => ({ billableItemId: idOf.get(p.code)!, unitPriceCents: p.requestedPriceCents! })),
      }, actor);

  const created = plan.filter(p => p.action === "create").map(p => p.code);
  const stocked = plan.filter(p => p.action === "create" || p.action === "add_stock_item").map(p => p.code);
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "stock_items.imported",
    entityType: "stock_item",
    summary: `Imported ${plan.length} items: ${created.length} new, ${stocked.length} stock items set up`,
    detail: { rows: plan.length, created, stockItemsAdded: stocked, priceChangeId: change?.id ?? null },
  });
  return { created: created.length, stockItemsAdded: stocked.length, unchanged: plan.length - stocked.length, priceChangeId: change?.id ?? null };
}
