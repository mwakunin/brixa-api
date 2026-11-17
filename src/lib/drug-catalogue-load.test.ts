import { sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import db, { appDb, pool } from "@/db";
import { pgErrorCode } from "@/lib/db-errors";
import { resetDb, waitForBlockedBackend } from "@/test/helpers";

import { drugCodeOf, DrugFileError, loadDrugCatalogue, parseCsv, parseDrugFile, seeingEveryFacility } from "./drug-catalogue-load";

/** P3 slice 4b: the drug catalogue's file, in this system's own format. */

const SAMPLE = path.resolve(import.meta.dirname, "../test/fixtures/drug-catalogue-sample.csv");
const HEADER = "code,generic_name,strength,form,dose_unit,route,controlled_schedule";

describe("the drug catalogue file", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("is read as CSV: quoted fields, doubled quotes, CRLF or LF, a byte-order mark", () => {
    expect(parseCsv("﻿a,\"b, c\",\"say \"\"hi\"\"\"\r\nd,e,f\n\n")).toEqual([["a", "b, c", "say \"hi\""], ["d", "e", "f"]]);
    expect(() => parseCsv("a,\"b")).toThrow(DrugFileError);
    expect(() => parseCsv("PCM,\"500\"0 mg,Tablet")).toThrow(/after a closing quote/);
    expect(() => parseCsv("PCM,Para\"cetamol,Tablet")).toThrow(/quote inside an unquoted field/);
  });

  it("is refused whole for a wrong header, a bad row, or a code twice", () => {
    const file = (...rows: string[]) => [HEADER, ...rows].join("\n");
    const refusal = (text: string) => {
      try {
        parseDrugFile(text);
        return "accepted";
      }
      catch (err) {
        return (err as Error).message;
      }
    };

    expect(refusal("code,name\nA,B")).toMatch(/header/);
    expect(refusal(file())).toMatch(/no drugs/);
    expect(refusal(file("PCM-500-TAB,Paracetamol,500 mg,Tablet,tablet,by mouth,"))).toMatch(/not a route/);
    expect(refusal(file("MOR-10-INJ,Morphine,10 mg/mL,Injection,mL,im,V"))).toMatch(/not a controlled schedule/);
    expect(refusal(file("pcm 500,Paracetamol,500 mg,Tablet,tablet,oral,"))).toMatch(/not a code/);
    expect(refusal(file("PCM-500-TAB,Paracetamol,,Tablet,tablet,oral,"))).toMatch(/empty/);
    // Longer than a prescription prints.
    expect(refusal(file(`PCM-500-TAB,Paracetamol,500 mg,${"Tablet ".repeat(20)},tablet,oral,`))).toMatch(/form is longer than 100/);
    expect(refusal(file("A,Paracetamol,500 mg,Tablet,tablet,oral,", "A,Ibuprofen,400 mg,Tablet,tablet,oral,"))).toMatch(/twice/);
    expect(parseDrugFile(file("MOR-10-INJ,Morphine,10 mg/mL,Injection,mL,im,II"))).toEqual([
      { code: "MOR-10-INJ", genericName: "Morphine", strength: "10 mg/mL", form: "Injection", doseUnit: "mL", route: "im", controlledSchedule: "II" },
    ]);
  });

  it("loads, updates in place, and retires what a later file lacks, but not too much at once", async () => {
    const sample = await readFile(SAMPLE, "utf8");
    expect(await loadDrugCatalogue(sample)).toEqual({ loaded: 10, retired: 0 });

    const renamed = sample.replace("Ibuprofen,400 mg", "Ibuprofen,400 mg film-coated");
    expect(await loadDrugCatalogue(renamed)).toEqual({ loaded: 10, retired: 0 });
    const { rows } = await pool.query("SELECT strength FROM drug_catalogue WHERE code = 'IBU-400-TAB'");
    expect(rows).toEqual([{ strength: "400 mg film-coated" }]);

    const many = [HEADER, ...Array.from({ length: 30 }, (_, i) => `D${i},Drug ${i},1 mg,Tablet,tablet,oral,`)].join("\n");
    await loadDrugCatalogue(many);
    await expect(loadDrugCatalogue(sample)).rejects.toThrow(/would retire 30 of 30/);
  });

  it("loads one file at a time: a load waits while another holds the catalogue", async () => {
    const file = (prefix: string) => [HEADER, ...Array.from({ length: 5 }, (_, i) => `${prefix}${i},Drug ${prefix}${i},1 mg,Tablet,tablet,oral,`)].join("\n");
    await loadDrugCatalogue(file("A"));
    const holder = await pool.connect();
    let loading: Promise<unknown> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('drug_catalogue_load', 0))");
      const { rows: [{ pid }] } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");

      loading = loadDrugCatalogue(file("B"));
      expect(await waitForBlockedBackend(pid)).toBe(true);
    }
    finally {
      await holder.query("COMMIT");
      holder.release();
    }
    await loading;

    const { rows } = await pool.query("SELECT left(code, 1) AS file FROM drug_catalogue WHERE retired_at IS NULL GROUP BY 1");
    expect(rows).toEqual([{ file: "B" }]);
  });

  it("finds a current drug's code by its exact name, strength and form, whatever its place in a search", async () => {
    await loadDrugCatalogue(await readFile(SAMPLE, "utf8"));

    expect(await drugCodeOf("paracetamol", "500 mg", "Tablet")).toBe("PCM-500-TAB");
    expect(await drugCodeOf("Artemether/Lumefantrine", "20 mg/120 mg", "Tablet")).toBe("AL-20/120-TAB");
    expect(await drugCodeOf("paracetamol", "500 mg", "Syrup")).toBeNull();
    await db.execute(sql`UPDATE drug_catalogue SET retired_at = now() WHERE code = 'PCM-500-TAB'`);
    expect(await drugCodeOf("paracetamol", "500 mg", "Tablet")).toBeNull();
  });

  it("fails, rather than seeing fewer facilities' stock, on a connection row security would filter", async () => {
    const counted = (on: typeof db) => on.transaction(async (tx) => {
      await seeingEveryFacility(tx);
      return tx.execute(sql`SELECT count(*) FROM stock_movements`);
    }).then(() => null, (e: unknown) => e);

    // The owner bypasses it, as it must (db/roles.sql); the app's role does not, and is refused, not shown nothing.
    expect(await counted(db)).toBeNull();
    expect(pgErrorCode(await counted(appDb as unknown as typeof db))).toBe("42501");
  });
});
