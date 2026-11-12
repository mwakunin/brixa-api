import { describe, expect, it } from "vitest";

import { parseDrugFile } from "./drug-catalogue-load";
import { convertGenericProducts, drugsCsv, reviewCsv } from "./ppb-generics";

/** P3 slice 4b: PPB's Generic Products list, converted into the drug catalogue's file. */

function codeSystem(...names: string[]) {
  return {
    resourceType: "CodeSystem",
    url: "https://fhir.dha.go.ke/terminology/CodeSystem/generic-products-cs",
    concept: names.map((display, i) => ({ code: `GE1${String(i).padStart(4, "0")}`, display })),
  };
}

describe("converting PPB's Generic Products", () => {
  it("reads the generic name, strength, route and form out of each name, and the dose unit from the form", () => {
    const { rows, review } = convertGenericProducts(codeSystem(
      "Metformin 500 mg Oral Tablet",
      "Artemether 20 mg/Lumefantrine 120 mg Oral Tablet",
      "Amoxicillin 125 mg/Sulbactam 125 mg per 5ml Oral Powder for Suspension",
      "Vitamin D3 400 IU Oral Drops",
      "Montelukast 5 mg Oral Tablet,Chewable",
      "Clindamycin 1 %w/w Topical Gel",
      "Budesonide 0.5 mg per 2ml Nebuliser Suspension",
      "Medroxyprogesterone 150 mg per 1ml Intramuscular Solution",
    ));

    expect(rows.map(r => [r.genericName, r.strength, r.route, r.form, r.doseUnit])).toEqual([
      ["Metformin", "500 mg", "oral", "Tablet", "tablet"],
      ["Artemether/Lumefantrine", "20 mg/120 mg", "oral", "Tablet", "tablet"],
      ["Amoxicillin/Sulbactam", "125 mg/125 mg per 5ml", "oral", "Powder for Suspension", "mL"],
      ["Vitamin D3", "400 IU", "oral", "Drops", "drop"],
      ["Montelukast", "5 mg", "oral", "Tablet, Chewable", "tablet"],
      ["Clindamycin", "1 %w/w", "topical", "Gel", "application"],
      ["Budesonide", "0.5 mg per 2ml", "inhaled", "Suspension", "mL"],
      ["Medroxyprogesterone", "150 mg per 1ml", "im", "Solution", "mL"],
    ]);
    expect(rows.every(r => r.controlledSchedule === null)).toBe(true);
    expect(review).toEqual([]);
  });

  it("lists for review what it left out, and what it kept but cannot vouch for", () => {
    const { rows, review } = convertGenericProducts(codeSystem(
      "Ceftriaxone 1000 mg Injection Powder for Suspension",
      "Colecalciferol 800 mg Oral Solution",
      "Fluticasone 250 mcg Oral Inhaler",
      "Triamcinolone 0.1 %w/w Buccal Gel",
      "Metformin 500 mg Oral Tablet",
      "Metformin 500 mg Oral Tablet",
    ));

    expect(rows.map(r => r.code)).toEqual(["GE10000", "GE10001", "GE10002", "GE10004", "GE10005"]);
    expect(rows[0]).toMatchObject({ route: "iv", doseUnit: "vial" });
    expect(review.map(r => [r.code, r.included, r.issue.split(":")[0]])).toEqual([
      ["GE10000", true, "An injection with no route"],
      ["GE10001", true, "A vitamin dosed in mg"],
      ["GE10002", true, "An inhaler given by mouth"],
      ["GE10003", false, "No route in the name that this reads (e.g. Buccal, Intravitreal, or none at all)"],
      ["GE10005", true, "The same product as GE10004"],
    ]);
    expect(reviewCsv(review).split("\n")[0]).toBe("code,name,in_catalogue,issue");
  });

  it("writes a file the catalogue's loader takes, quoting what needs it", () => {
    const { rows } = convertGenericProducts(codeSystem("Montelukast 5 mg Oral Tablet,Chewable", "Paracetamol 500 mg Oral Tablet"));

    const csv = drugsCsv(rows);

    expect(csv).toContain("\"Tablet, Chewable\"");
    expect(parseDrugFile(csv)).toEqual(rows);
  });

  it("refuses a file that is not PPB's Generic Products", () => {
    expect(() => convertGenericProducts({ resourceType: "ValueSet" })).toThrow();
    expect(() => convertGenericProducts({ ...codeSystem("Metformin 500 mg Oral Tablet"), concept: [] })).toThrow();
    expect(() => convertGenericProducts({ ...codeSystem("Metformin 500 mg Oral Tablet"), url: "https://fhir.dha.go.ke/terminology/CodeSystem/formulation-cs" })).toThrow();
  });

  it("flags a powder counted in vials with a strength per mL", () => {
    const { review } = convertGenericProducts(codeSystem("Ceftriaxone 250 mg per 1ml Intravenous Powder for Solution"));
    expect(review.map(r => r.issue.split(":")[0])).toEqual(["A powder counted in vials with a strength per mL"]);
  });

  it("keeps a name that looks like a formula from running in a spreadsheet", () => {
    const csv = reviewCsv([{ code: "GE19999", display: "=HYPERLINK(\"x\")", included: false, issue: "No route" }]);
    expect(csv.split("\n")[1]).toBe("GE19999,\"'=HYPERLINK(\"\"x\"\")\",no,No route");
  });
});
