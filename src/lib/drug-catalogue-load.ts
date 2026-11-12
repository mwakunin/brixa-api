import { and, isNull, notInArray, sql } from "drizzle-orm";

import db from "@/db";
import { drugCatalogue } from "@/db/schema";

import type { ControlledSchedule, DrugRoute } from "./drug-catalogue";

import { DRUG_ROUTES } from "./drug-catalogue";

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
const CODE_SHAPE = /^[A-Z0-9][A-Z0-9._/-]{0,31}$/;
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
  if (!CODE_SHAPE.test(code))
    throw new DrugFileError(`row ${line}: ${JSON.stringify(code)} is not a code (A–Z, 0–9, . _ / -, at most 32)`);
  if (![genericName, strength, form, doseUnit].every(Boolean))
    throw new DrugFileError(`row ${line} (${code}) leaves a name, strength, form or dose unit empty`);
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

/** Loads a file's drugs, retiring those it no longer has; returns the counts. */
export async function loadDrugCatalogue(text: string, now = new Date()): Promise<{ loaded: number; retired: number }> {
  const rows = parseDrugFile(text);
  const codes = rows.map(r => r.code);

  return db.transaction(async (tx) => {
    // One load at a time: the next reads what this one committed, so two
    // overlapping loads cannot both leave their drugs in use.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${"drug_catalogue_load"}, 0))`);
    const current = await tx.select({ code: drugCatalogue.code }).from(drugCatalogue).where(isNull(drugCatalogue.retiredAt));
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
    const retired = await tx.update(drugCatalogue)
      .set({ retiredAt: now })
      .where(and(isNull(drugCatalogue.retiredAt), notInArray(drugCatalogue.code, codes)))
      .returning({ code: drugCatalogue.code });
    return { loaded: rows.length, retired: retired.length };
  });
}
