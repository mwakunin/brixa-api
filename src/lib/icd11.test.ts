import { asc } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import db from "@/db";
import { icdCodes } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import { makeFacility, resetDb } from "@/test/helpers";

import { searchIcd } from "./icd11";
import { IcdFileError, loadIcd11 } from "./icd11-load";

/**
 * The fixture is seventeen records copied byte for byte from WHO's 2026-01
 * simple tabulation (BOM, CRLF, quoting, and a coding note with bare line
 * feeds): two chapters, a block, twelve categories of chapters 01 and 12, and
 * one each of chapters 26 and X, which are not loaded.
 * ICD-11 © WHO 2019, https://icd.who.int/browse11, CC BY-ND 3.0 IGO.
 */
const SAMPLE = path.resolve(import.meta.dirname, "../test/fixtures/icd11-mms-sample.txt");

const sample = () => readFile(SAMPLE, "utf8");

/** The sample as a later release: a new version line, `drop` removed, `retitle` renamed. */
async function laterRelease(options: { drop?: string; retitle?: [string, string] } = {}) {
  const lines = (await sample()).split("\r\n").filter(line => !options.drop || !line.includes(`\t${options.drop}\t`));
  let text = lines.join("\r\n").replace("Version:2026 Jan", "Version:2027 Jan");
  if (options.retitle)
    text = text.replace(`"- - - - ${options.retitle[0]}"`, `"- - - - ${options.retitle[1]}"`);
  return text;
}

beforeEach(async () => {
  await resetDb();
});

describe("loading an ICD-11 release", () => {
  it("keeps the categories of chapters 01 to 25, titled as WHO titles them, each with its URI", async () => {
    expect(await loadIcd11(await sample())).toEqual({ release: "2026-01", loaded: 12, retired: 0 });

    const rows = await db.select().from(icdCodes).orderBy(asc(icdCodes.code));
    expect(rows.map(r => r.code)).toEqual(["1C1G", "1C62", "1C62.0", "1C62.Z", "1F40", "1F40.0", "1F40.Y", "1F40.Z", "CA40", "CA40.0", "CA40.00", "CA40.01"]);
    expect(rows.find(r => r.code === "1F40.0")).toMatchObject({
      title: "Plasmodium falciparum malaria with cerebral complications",
      uri: "http://id.who.int/icd/release/11/mms/1143114898",
      chapter: "01",
      isLeaf: true,
      isResidual: false,
      release: "2026-01",
      retiredAt: null,
    });
    // A residual code has no foundation URI; its linearization URI is kept.
    expect(rows.find(r => r.code === "1F40.Z")).toMatchObject({ isResidual: true, uri: expect.stringMatching(/\/unspecified$/) });
    // The record whose coding note runs over several lines is read whole.
    expect(rows.find(r => r.code === "1C1G")).toMatchObject({ title: "Lyme borreliosis", isLeaf: false });
  });

  it("retires a code a later release no longer has, and refuses to go back to an older release", async () => {
    await loadIcd11(await sample());

    expect(await loadIcd11(await laterRelease({ drop: "CA40.01" }))).toEqual({ release: "2027-01", loaded: 11, retired: 1 });
    const rows = await db.select().from(icdCodes);
    expect(rows.find(r => r.code === "CA40.01")).toMatchObject({ release: "2026-01", retiredAt: expect.any(Date) });
    expect(rows.filter(r => r.code !== "CA40.01").every(r => r.release === "2027-01" && r.retiredAt === null)).toBe(true);

    await expect(loadIcd11(await sample())).rejects.toBeInstanceOf(IcdFileError);
  });

  it("refuses a file that is not WHO's tabulation, and changes nothing", async () => {
    await expect(loadIcd11("Code\tTitle\r\n1A00\tCholera\r\n")).rejects.toBeInstanceOf(IcdFileError);
    const noVersion = (await sample()).replace("Version:2026 Jan 17", "Released sometime");
    await expect(loadIcd11(noVersion)).rejects.toThrow(/Version/);

    expect(await db.select().from(icdCodes)).toEqual([]);
  });

  it("refuses a file cut short, before it retires what the missing part held", async () => {
    await loadIcd11(await sample());
    // WHO prints the extension codes (chapter X) last: a file without them stops early.
    const cut = (await laterRelease()).split("\r\n").filter(line => !line.includes("\tX\t")).join("\r\n");

    await expect(loadIcd11(cut)).rejects.toThrow(/cut short/);
    expect((await db.select().from(icdCodes)).every(r => r.release === "2026-01" && r.retiredAt === null)).toBe(true);
  });

  it("refuses a category whose leaf or residual flag is neither True nor False", async () => {
    const bad = (await sample()).split("\r\n").map(line => line.includes("\t1F40.0\t")
      ? line.replace("\t2\tFalse\t01\t", "\t2\tfalse\t01\t")
      : line).join("\r\n");
    expect(bad).not.toBe(await sample());

    await expect(loadIcd11(bad)).rejects.toThrow(/1F40\.0/);
    expect(await db.select().from(icdCodes)).toEqual([]);
  });
});

describe("searching ICD-11", () => {
  async function search(q: string) {
    const facility = await makeFacility();
    return runAsFacility(facility.id, tx => searchIcd(tx, q));
  }

  it("finds codes specific enough to record, by the start of each word typed", async () => {
    await loadIcd11(await sample());

    const malaria = (await search("falc MAL")).map(c => c.code);
    expect(malaria.sort()).toEqual(["1F40.0", "1F40.Y", "1F40.Z"]);
    expect((await search("pneumonia coli")).map(c => c.code)).toEqual(["CA40.01"]);
    expect(await search("lyme")).toEqual([]);
  });

  it("finds a code by the code, the exact one first", async () => {
    await loadIcd11(await sample());

    const found = await search("1f40.z");
    expect(found[0]).toEqual({
      code: "1F40.Z",
      title: "Malaria due to Plasmodium falciparum, unspecified",
      uri: expect.stringContaining("http://id.who.int/icd/release/11/mms/"),
      residual: true,
    });
    expect((await search("1F40")).map(c => c.code).sort()).toEqual(["1F40.0", "1F40.Y", "1F40.Z"]);
  });

  it("leaves out codes the current release no longer has", async () => {
    await loadIcd11(await sample());
    await loadIcd11(await laterRelease({ drop: "CA40.01" }));

    expect(await search("pneumonia coli")).toEqual([]);
  });
});
