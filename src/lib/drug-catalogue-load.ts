import { and, isNotNull, isNull, notInArray, sql } from "drizzle-orm";

import db from "@/db";
import { controlledDrugRegister, drugCatalogue, stockBatches, stockItems, stockMovements } from "@/db/schema";

import type { ControlledSchedule, DrugRoute } from "./drug-catalogue";

import { DRUG_CODE_SHAPE, DRUG_ROUTES } from "./drug-catalogue";

/**
 * Loads the shared drug catalogue (SCHEMA.md §8, P3 slice 4b) from a CSV
 * file in this system's own format (decided 2026-11-11), into which PPB's
 * Generic Products list (decided 2026-11-12, SPEC.md §2) is to be converted:
 *
 *   code,generic_name,strength,form,dose_unit,route,controlled_schedule
 *   PCM-500-TAB,Paracetamol,500 mg,Tablet,tablet,oral,
 *
 * UTF-8 (a byte-order mark is allowed), comma-separated, with "quoted"
 * fields where a value holds a comma or a quote ("" for a quote inside).
 * `route` is one of `DRUG_ROUTES`; `controlled_schedule` is I to IV, or empty
 * for a drug that is not controlled (rule 12).
 *
 * The file is read whole and loaded in one transaction, so a bad row leaves
 * the table as it was. A code the file no longer has is retired, never
 * deleted: past prescriptions name it. Run on the OWNER connection, because
 * the app role may only read shared reference data (CLAUDE.md rule 1).
 */

export class DrugFileError extends Error {
  constructor(message: string) {
    super(`Not a usable drug catalogue file: ${message}`);
    this.name = "DrugFileError";
  }
}

export interface DrugRow {
  code: string;
  genericName: string;
  strength: string;
  form: string;
  doseUnit: string;
  route: DrugRoute;
  controlledSchedule: ControlledSchedule | null;
}

const HEADER = ["code", "generic_name", "strength", "form", "dose_unit", "route", "controlled_schedule"];
/** The longest of each printed field, so every drug fits its prescription's cell. */
const MAX_LENGTHS = { generic_name: 200, strength: 100, form: 100, dose_unit: 30 } as const;
const SCHEDULES: readonly string[] = ["I", "II", "III", "IV"];
const BATCH = 500;
/**
 * How many current drugs one load may retire: a tenth of them, or 20 if that
 * is more. More means a file with rows missing, and loading it would take
 * them out of prescribing; a load that truly retires more needs this raised.
 */
const RETIRE_AT_MOST = (current: number) => Math.max(20, Math.ceil(current * 0.1));

/** RFC 4180 records: commas between fields, CRLF or LF between records, quotes around a field that needs them. */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  /** Just past a closing quote, where only a comma or the record's end may come. */
  let closed = false;
  const source = text.startsWith("﻿") ? text.slice(1) : text;

  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (quoted) {
      if (c === "\"" && source[i + 1] === "\"") {
        field += "\"";
        i += 1;
      }
      else if (c === "\"") {
        quoted = false;
        closed = true;
      }
      else {
        field += c;
      }
      continue;
    }
    if (closed && c !== "," && c !== "\n" && c !== "\r")
      throw new DrugFileError(`record ${records.length + 1} has ${JSON.stringify(c)} after a closing quote`);
    closed = false;
    if (c === "\"" && field === "") {
      quoted = true;
    }
    else if (c === "\"") {
      throw new DrugFileError(`record ${records.length + 1} has a quote inside an unquoted field`);
    }
    else if (c === ",") {
      record.push(field);
      field = "";
    }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && source[i + 1] === "\n")
        i += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    }
    else {
      field += c;
    }
  }
  if (quoted)
    throw new DrugFileError("a quoted field is never closed");
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records.filter(r => r.some(f => f.trim() !== ""));
}

function rowOf(fields: string[], line: number): DrugRow {
  if (fields.length !== HEADER.length)
    throw new DrugFileError(`row ${line} has ${fields.length} fields, not ${HEADER.length}`);
  const [code, genericName, strength, form, doseUnit, route, schedule] = fields.map(f => f.trim());
  if (!DRUG_CODE_SHAPE.test(code))
    throw new DrugFileError(`row ${line}: ${JSON.stringify(code)} is not a code (A–Z, 0–9, . _ / -, at most 32)`);
  if (![genericName, strength, form, doseUnit].every(Boolean))
    throw new DrugFileError(`row ${line} (${code}) leaves a name, strength, form or dose unit empty`);
  const tooLong = Object.entries({ generic_name: genericName, strength, form, dose_unit: doseUnit })
    .find(([column, value]) => value.length > MAX_LENGTHS[column as keyof typeof MAX_LENGTHS]);
  if (tooLong)
    throw new DrugFileError(`row ${line} (${code}): ${tooLong[0]} is longer than ${MAX_LENGTHS[tooLong[0] as keyof typeof MAX_LENGTHS]} characters`);
  if (!(DRUG_ROUTES as readonly string[]).includes(route))
    throw new DrugFileError(`row ${line} (${code}): ${JSON.stringify(route)} is not a route (${DRUG_ROUTES.join(", ")})`);
  if (schedule !== "" && !SCHEDULES.includes(schedule))
    throw new DrugFileError(`row ${line} (${code}): ${JSON.stringify(schedule)} is not a controlled schedule (I to IV, or empty)`);
  return {
    code,
    genericName,
    strength,
    form,
    doseUnit,
    route: route as DrugRoute,
    controlledSchedule: schedule === "" ? null : schedule as ControlledSchedule,
  };
}

/** The file's drugs, checked; refused whole if any row is wrong. */
export function parseDrugFile(text: string): DrugRow[] {
  const [header, ...records] = parseCsv(text);
  if (!header || header.map(h => h.trim().toLowerCase()).join(",") !== HEADER.join(","))
    throw new DrugFileError(`the header must be ${HEADER.join(",")}`);
  if (records.length === 0)
    throw new DrugFileError("it has no drugs");

  const rows = records.map((fields, i) => rowOf(fields, i + 2));
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.code))
      throw new DrugFileError(`${row.code} appears twice`);
    seen.add(row.code);
  }
  return rows;
}

type OwnerTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Makes this transaction fail, rather than see fewer rows, wherever row
 * security would filter what it reads (`row_security = off`). The owner
 * bypasses it, as it must to load for every facility (db/roles.sql); an
 * owner left without BYPASSRLS would otherwise bring forward no facility's
 * stock, silently.
 */
export async function seeingEveryFacility(tx: OwnerTx): Promise<void> {
  await tx.execute(sql`SET LOCAL row_security = off`);
}

/**
 * Holds the ledger and the stock items still until the load commits, then
 * refuses to schedule a drug (`codes`) a facility counts in two base units:
 * its register, one per drug and store, would add them (migration 0100).
 */
async function holdForSchedule(tx: OwnerTx, codes: string[]): Promise<void> {
  await tx.execute(sql`LOCK TABLE ${stockMovements}, ${stockItems} IN SHARE MODE`);
  if (codes.length === 0)
    return;
  const { rows } = await tx.execute<{ code: string }>(sql`
    SELECT DISTINCT ${stockItems.drugCode} AS code FROM ${stockItems}
    WHERE ${stockItems.drugCode} IN (${sql.join(codes.map(c => sql`${c}`), sql`, `)})
    GROUP BY ${stockItems.facilityId}, ${stockItems.drugCode}
    HAVING count(DISTINCT ${stockItems.baseUnit}) > 1
    ORDER BY 1`);
  if (rows.length > 0)
    throw new DrugFileError(`it would make ${rows.map(r => r.code).join(", ")} controlled, which a facility stocks in two base units; give its stock items one unit first`);
}

/**
 * Opens a register page, in every facility's store holding a drug just
 * scheduled, with the stock it holds (P4 slice 4). A store with a page
 * already, from an earlier schedule, keeps it: its page never stopped.
 * On the owner connection, across facilities, as the load is.
 */
async function bringForward(tx: OwnerTx, codes: string[]): Promise<void> {
  await tx.execute(sql`
    INSERT INTO ${controlledDrugRegister} (facility_id, store_id, drug_code, kind, quantity, balance, recorded_at)
    SELECT m.facility_id, m.store_id, si.drug_code, 'brought_forward', sum(m.quantity), sum(m.quantity), clock_timestamp()
    FROM ${stockMovements} m
    JOIN ${stockBatches} b ON b.id = m.batch_id
    JOIN ${stockItems} si ON si.id = b.stock_item_id
    WHERE si.drug_code IN (${sql.join(codes.map(c => sql`${c}`), sql`, `)})
      AND NOT EXISTS (
        SELECT 1 FROM ${controlledDrugRegister} r
        WHERE r.facility_id = m.facility_id AND r.store_id = m.store_id AND r.drug_code = si.drug_code
      )
    GROUP BY m.facility_id, m.store_id, si.drug_code
    HAVING sum(m.quantity) <> 0`);
}

/** Loads a file's drugs, retiring those it no longer has; returns the counts. */
export async function loadDrugCatalogue(text: string, now = new Date()): Promise<{ loaded: number; retired: number }> {
  const rows = parseDrugFile(text);
  const codes = rows.map(r => r.code);

  return db.transaction(async (tx) => {
    await seeingEveryFacility(tx);
    // One load at a time: the next reads what this one committed, so two
    // overlapping loads cannot both leave their drugs in use.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${"drug_catalogue_load"}, 0))`);
    const current = await tx.select({ code: drugCatalogue.code }).from(drugCatalogue).where(isNull(drugCatalogue.retiredAt));
    const scheduledNow = new Set((await tx.select({ code: drugCatalogue.code }).from(drugCatalogue).where(isNotNull(drugCatalogue.controlledSchedule))).map(d => d.code));
    const newlyScheduled = rows.filter(r => r.controlledSchedule && !scheduledNow.has(r.code)).map(r => r.code);
    const unscheduling = rows.some(r => !r.controlledSchedule && scheduledNow.has(r.code));
    // A drug becoming controlled has its stock brought into the register, with no movement between the
    // count and the schedule: the ledger and the stock items are held still (writes wait) until this load commits.
    // One ceasing to be is held the same way: a first movement still being written commits its page first,
    // so the next movement finds the page and is not taken for an unscheduled drug's. Rare, by design.
    if (newlyScheduled.length > 0 || unscheduling)
      await holdForSchedule(tx, newlyScheduled);
    const leaving = current.filter(c => !codes.includes(c.code)).length;
    if (leaving > RETIRE_AT_MOST(current.length))
      throw new DrugFileError(`it would retire ${leaving} of ${current.length} drugs in use; is it complete?`);

    for (let i = 0; i < rows.length; i += BATCH) {
      await tx.insert(drugCatalogue)
        .values(rows.slice(i, i + BATCH).map(r => ({ ...r, loadedAt: now })))
        .onConflictDoUpdate({
          target: drugCatalogue.code,
          set: {
            genericName: sql`excluded.generic_name`,
            strength: sql`excluded.strength`,
            form: sql`excluded.form`,
            doseUnit: sql`excluded.dose_unit`,
            route: sql`excluded.route`,
            controlledSchedule: sql`excluded.controlled_schedule`,
            loadedAt: now,
            retiredAt: null,
          },
        });
    }
    if (newlyScheduled.length > 0)
      await bringForward(tx, newlyScheduled);
    const retired = await tx.update(drugCatalogue)
      .set({ retiredAt: now })
      .where(and(isNull(drugCatalogue.retiredAt), notInArray(drugCatalogue.code, codes)))
      .returning({ code: drugCatalogue.code });
    return { loaded: rows.length, retired: retired.length };
  });
}
