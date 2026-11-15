import { and, eq, inArray, isNull } from "drizzle-orm";

import type { AppDb } from "@/db";

import { billableItems, drugCatalogue, priceChangeLines, priceChanges, stockItems } from "@/db/schema";

import type { DrugMatch } from "./drug-catalogue";
import type { PatientActor } from "./patients";

import { recordAudit } from "./audit";
import { businessDate } from "./dates";
import { isUniqueViolation } from "./db-errors";
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
  constructor(readonly code: "unreadable" | "has_problems" | "changed_meanwhile", message: string, readonly rows?: PlannedRow[]) {
    super(message);
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

/** Each row's plan, with the fields it was read from. */
async function planRows(tx: AppDb, csv: string, today: string): Promise<{ planned: PlannedRow; parsed: ParsedRow }[]> {
  const rows = readFile(csv);

  const seen = new Map<string, number>();
  for (const r of rows) {
    const first = seen.get(r.code);
    if (first !== undefined)
      r.problems.push(`code ${r.code} is also on row ${first}`);
    else
      seen.set(r.code, r.row);
  }

  const existing = new Map((await listBillableItems(tx, today)).filter(i => seen.has(i.code)).map(i => [i.code, i]));
  const ids = [...existing.values()].map(i => i.id);
  const stockOf = new Map(ids.length === 0
    ? []
    : (await tx.select().from(stockItems).where(inArray(stockItems.billableItemId, ids))).map(s => [s.billableItemId, s]));
  // A price already waiting for approval is not asked for again, so a file run twice before approval asks once.
  const pending = new Set(ids.length === 0
    ? []
    : (await tx
        .select({ billableItemId: priceChangeLines.billableItemId, unitPriceCents: priceChangeLines.unitPriceCents })
        .from(priceChangeLines)
        .innerJoin(priceChanges, eq(priceChanges.id, priceChangeLines.priceChangeId))
        .where(and(eq(priceChanges.status, "pending"), eq(priceChanges.priceListId, await cashPriceList(tx)), inArray(priceChangeLines.billableItemId, ids))))
        .map(l => `${l.billableItemId}:${l.unitPriceCents}`));
  const drugCodes = [...new Set(rows.map(r => r.drugCode).filter((c): c is string => c !== null))];
  const currentDrugs = new Set(drugCodes.length === 0
    ? []
    : (await tx.select({ code: drugCatalogue.code }).from(drugCatalogue).where(and(inArray(drugCatalogue.code, drugCodes), isNull(drugCatalogue.retiredAt)))).map(d => d.code));

  let suggested = 0;
  const planned: { planned: PlannedRow; parsed: ParsedRow }[] = [];
  for (const r of rows) {
    const problems = [...r.problems];
    let suggestions: PlannedRow["suggestions"] = [];
    if (r.category === "drug" && !r.drugCode) {
      problems.push("drug_code: needed for a drug; choose its catalogue drug");
      const word = searchWordOf(r.name);
      if (word && suggested < MAX_SUGGESTED_ROWS) {
        suggested += 1;
        suggestions = (await searchDrugs(tx, word)).slice(0, SUGGESTIONS).map(d => ({ code: d.code, genericName: d.genericName, strength: d.strength, form: d.form }));
      }
    }
    if (r.drugCode && DRUG_CODE_SHAPE.test(r.drugCode) && !currentDrugs.has(r.drugCode))
      problems.push(`drug_code: ${r.drugCode} is not a current catalogue drug`);

    const item = existing.get(r.code);
    const stock = item ? stockOf.get(item.id) : undefined;
    if (item) {
      if (item.category !== r.category)
        problems.push(`code ${r.code} is already a ${item.category} item`);
      if (!item.isActive)
        problems.push(`code ${r.code} is a retired item`);
    }
    if (stock) {
      if (stock.drugCode !== r.drugCode)
        problems.push(`code ${r.code} is already stocked as ${stock.drugCode ?? "a consumable"}`);
      if (stock.baseUnit !== r.baseUnit)
        problems.push(`code ${r.code} is already counted in ${stock.baseUnit}`);
      if (stock.packSize !== r.packSize)
        problems.push(`code ${r.code} already comes in packs of ${stock.packSize}; change it on the item`);
    }

    const priceDiffers = r.priceCents !== null && r.priceCents !== (item?.cashPriceCents ?? null)
      && !(item && pending.has(`${item.id}:${r.priceCents}`));
    planned.push({
      planned: {
        row: r.row,
        code: r.code,
        name: item?.name ?? r.name,
        action: problems.length > 0 ? null : !item ? "create" : !stock ? "add_stock_item" : "unchanged",
        requestedPriceCents: problems.length === 0 && priceDiffers ? r.priceCents : null,
        problems,
        suggestions,
      },
      parsed: r,
    });
  }
  return planned;
}

/**
 * What importing the file would do, row by row, with every problem found.
 * Writes nothing. Not patient data, so not audited.
 */
export async function planImport(tx: AppDb, csv: string, today = businessDate()): Promise<PlannedRow[]> {
  return (await planRows(tx, csv, today)).map(p => p.planned);
}

export interface ImportResult {
  created: number;
  stockItemsAdded: number;
  unchanged: number;
  /** The price change awaiting approval; null when no price changed. */
  priceChangeId: string | null;
}

/**
 * Imports the file: refused whole, with every problem, if any row has one.
 * New items, their stock items and the audit entry commit together; the
 * prices wait in one price change for the finance manager.
 */
export async function importItems(
  tx: AppDb,
  facilityId: string,
  csv: string,
  actor: PatientActor,
  options: { effectiveFrom?: string; today?: string } = {},
): Promise<ImportResult> {
  const today = options.today ?? businessDate();
  // Before anything is written: a price change cannot start in the past.
  if (options.effectiveFrom !== undefined && options.effectiveFrom < today)
    throw new PriceError("effective_in_past");
  const rows = await planRows(tx, csv, today);
  const plan = rows.map(r => r.planned);
  const parsedOf = new Map(rows.map(r => [r.planned, r.parsed]));
  const refused = plan.filter(p => p.problems.length > 0);
  if (refused.length > 0)
    throw new ItemImportError("has_problems", `${refused.length} row${refused.length === 1 ? " has" : "s have"} problems; nothing was imported`, refused);

  const toCreate = plan.filter(p => p.action === "create");
  const toStock = plan.filter(p => p.action === "create" || p.action === "add_stock_item");
  const idOf = new Map((await listBillableItems(tx, today)).filter(i => plan.some(p => p.code === i.code)).map(i => [i.code, i.id]));

  try {
    if (toCreate.length > 0) {
      const inserted = await tx.insert(billableItems)
        .values(toCreate.map(p => ({ facilityId, code: p.code, name: p.name, category: parsedOf.get(p)!.category as "drug" | "consumable" })))
        .returning({ id: billableItems.id, code: billableItems.code });
      for (const i of inserted)
        idOf.set(i.code, i.id);
    }
    if (toStock.length > 0) {
      await tx.insert(stockItems).values(toStock.map((p) => {
        const r = parsedOf.get(p)!;
        return { facilityId, billableItemId: idOf.get(p.code)!, drugCode: r.drugCode, baseUnit: r.baseUnit, packSize: r.packSize! };
      }));
    }
  }
  catch (err) {
    // Another import or a hand-made item took one of these codes after the plan was read.
    if (isUniqueViolation(err))
      throw new ItemImportError("changed_meanwhile", "An item in this file was set up by someone else meanwhile; preview it again");
    throw err;
  }

  const priced = plan.filter(p => p.requestedPriceCents !== null);
  const change = priced.length === 0
    ? null
    : await requestPriceChange(tx, facilityId, {
        effectiveFrom: options.effectiveFrom ?? today,
        reason: "Item import",
        lines: priced.map(p => ({ billableItemId: idOf.get(p.code)!, unitPriceCents: p.requestedPriceCents! })),
      }, actor);

  const result = {
    created: toCreate.length,
    stockItemsAdded: toStock.length,
    unchanged: plan.length - toStock.length,
    priceChangeId: change?.id ?? null,
  };
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "stock_items.imported",
    entityType: "stock_item",
    summary: `Imported ${plan.length} items: ${result.created} new, ${result.stockItemsAdded} stock items set up`,
    detail: {
      rows: plan.length,
      created: toCreate.map(p => p.code),
      stockItemsAdded: toStock.map(p => p.code),
      priceChangeId: result.priceChangeId,
    },
  });
  return result;
}
