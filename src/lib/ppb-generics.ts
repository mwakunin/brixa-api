import { z } from "zod";

import type { DrugRoute } from "./drug-catalogue";
import type { DrugRow } from "./drug-catalogue-load";

import { INJECTED_ROUTES } from "./drug-catalogue";

/**
 * Converts PPB's Generic Products list, as DHA's ePrescription guide
 * publishes it (a FHIR CodeSystem, `generic-products-cs`), into the drug
 * catalogue's CSV (decided 2026-11-12, SPEC.md §2). It writes nothing to the
 * database: `pnpm drugs:load` loads its output once a pharmacist has worked
 * through the review list beside it.
 *
 * The list gives each product a code and a name only, e.g. `GE10002`
 * "Metformin 500 mg Oral Tablet", so the generic name, strength, route and
 * form are read out of the name, and the dose unit follows from the form.
 * A name that cannot be read is left out and listed for review. So is
 * anything this cannot judge: an injection with no route (given IV, to be
 * checked), a vitamin dosed in mg, an inhaler given by mouth, a product
 * listed twice. The list has no controlled schedules: those come from the
 * Pharmacy and Poisons Act's schedules, by hand.
 */

/** The list's canonical URL in DHA's ePrescription guide: any other code system is refused. */
export const GENERIC_PRODUCTS_URL = "https://fhir.dha.go.ke/terminology/CodeSystem/generic-products-cs";

const CodeSystemSchema = z.object({
  resourceType: z.literal("CodeSystem"),
  url: z.literal(GENERIC_PRODUCTS_URL),
  concept: z.array(z.object({ code: z.string(), display: z.string() })).min(1),
});

/** PPB's route words, and the catalogue's route for each. */
const ROUTES: Record<string, DrugRoute> = {
  Oral: "oral",
  Sublingual: "sublingual",
  Intravenous: "iv",
  Intramuscular: "im",
  Subcutaneous: "sc",
  Intradermal: "intradermal",
  Topical: "topical",
  Cutaneous: "topical",
  Rectal: "rectal",
  Vaginal: "vaginal",
  Inhalation: "inhaled",
  Nebuliser: "inhaled",
  Nasal: "nasal",
  Ophthalmic: "ophthalmic",
  Otic: "otic",
};

/** What a dose of each form is counted in. The first pattern that matches wins. */
const DOSE_UNITS: [RegExp, string][] = [
  [/^Tablet/i, "tablet"],
  [/^Capsule/i, "capsule"],
  [/Powder for (?:Solution|Suspension)$/i, "mL"],
  [/^(?:Solution|Syrup|Suspension|Emulsion|Elixir)$/i, "mL"],
  [/^Drops$/i, "drop"],
  [/^(?:Cream|Gel|Ointment|Lotion|Shampoo)$/i, "application"],
  [/^Suppository$/i, "suppository"],
  [/^Pessary$/i, "pessary"],
  [/^(?:Inhaler|Aerosol)/i, "puff"],
  [/^Spray$/i, "spray"],
  [/^(?:Sachet|Powder)$/i, "sachet"],
  [/^Patch$/i, "patch"],
  [/^Lozenge$/i, "lozenge"],
  [/^Film$/i, "film"],
  [/^Gum$/i, "piece"],
  [/^Implant$/i, "implant"],
  [/^lyophilizates$/i, "vial"],
];

export interface ReviewItem {
  code: string;
  display: string;
  /** Left out of the catalogue, or in it but to be checked. */
  included: boolean;
  issue: string;
}

export interface Converted {
  rows: DrugRow[];
  review: ReviewItem[];
}

/** A token that starts a strength: a number, as in "500", "0.5" or "1%". */
const NUMBER = /^\d[\d.,]*%?$/;

/** "Vitamin D3 400 IU" → name and strength, split before the first number standing alone. */
function nameAndStrength(part: string): { name: string; strength: string } | null {
  const tokens = part.trim().split(/\s+/);
  const at = tokens.findIndex((t, i) => i > 0 && NUMBER.test(t));
  return at < 0 ? null : { name: tokens.slice(0, at).join(" "), strength: tokens.slice(at).join(" ") };
}

/** "Amoxicillin 125 mg/Sulbactam 125 mg per 5ml" → names and strengths, or null if a part does not read. */
function namesAndStrengths(text: string): { genericName: string; strength: string } | null {
  const parts = text.split(/\/(?=[A-Z])/).map(nameAndStrength);
  if (parts.some(p => !p))
    return null;
  return {
    genericName: parts.map(p => p!.name).join("/"),
    strength: parts.map(p => p!.strength).join("/"),
  };
}

/** Dose units of the forms made for injection: a powder by the vial, a liquid by the mL, an implant as itself. */
const INJECTED_UNITS = ["vial", "mL", "implant"];

function doseUnitOf(form: string, route: DrugRoute): string | null {
  if (INJECTED_ROUTES.includes(route)) {
    if (/Powder for/i.test(form) || /^lyophilizates$/i.test(form))
      return "vial";
    if (/(?:Solution|Suspension|Emulsion)$/i.test(form) || /^Injection$/i.test(form))
      return "mL";
  }
  return DOSE_UNITS.find(([pattern]) => pattern.test(form))?.[1] ?? null;
}

/**
 * Where the route word is: the first one after the first number, so a name
 * that begins "Oral rehydration salts" keeps its own "Oral". "Injection"
 * stands in for a route PPB did not give.
 */
function routeAt(tokens: string[]): number {
  const firstNumber = tokens.findIndex((t, i) => i > 0 && NUMBER.test(t));
  return tokens.findIndex((t, i) => i > firstNumber && firstNumber >= 0 && (t in ROUTES || t === "Injection"));
}

/** One product read out of its name, with what a reviewer should check; or a reason it cannot be read. */
function read(code: string, display: string): { row: DrugRow; issues: string[] } | { reason: string } {
  const tokens = display.split(/\s+/);
  const at = routeAt(tokens);
  if (at < 0 || at === tokens.length - 1)
    return { reason: "No route in the name that this reads (e.g. Buccal, Intravitreal, or none at all)" };

  const issues: string[] = [];
  let route = ROUTES[tokens[at]];
  if (tokens[at] === "Injection") {
    route = "iv";
    issues.push("An injection with no route: given IV here; check whether it is IV, IM or either");
  }
  const parsed = namesAndStrengths(tokens.slice(0, at).join(" "));
  if (!parsed)
    return { reason: "The generic name and strength could not be told apart" };
  const form = tokens.slice(at + 1).join(" ").split(",").map(p => p.trim()).join(", ");
  const doseUnit = doseUnitOf(form, route);
  if (!doseUnit)
    return { reason: `No dose unit for the form "${form}"` };

  if (/calciferol|cobalamin/i.test(parsed.genericName) && /\bmg\b/.test(parsed.strength))
    issues.push("A vitamin dosed in mg: usually IU or mcg; check the strength");
  if (route === "oral" && /^(?:Inhaler|Aerosol)/i.test(form))
    issues.push("An inhaler given by mouth: check the route");
  if (INJECTED_ROUTES.includes(route) && !INJECTED_UNITS.includes(doseUnit))
    issues.push("A form not made for injection, with an injected route: check the route and form");
  if (doseUnit === "vial" && /\bper\b/i.test(parsed.strength))
    issues.push("A powder counted in vials with a strength per mL: check the dose unit");

  return { row: { code, ...parsed, form, doseUnit, route, controlledSchedule: null }, issues };
}

/** The catalogue rows the list yields, and everything a pharmacist should look at before loading them. */
export function convertGenericProducts(codeSystem: unknown): Converted {
  const { concept } = CodeSystemSchema.parse(codeSystem);
  const rows: DrugRow[] = [];
  const review: ReviewItem[] = [];
  const seen = new Map<string, string>();

  for (const { code, display } of concept) {
    const read_ = read(code.trim(), display.trim());
    if ("reason" in read_) {
      review.push({ code, display, included: false, issue: read_.reason });
      continue;
    }
    const { row, issues } = read_;
    const key = [row.genericName, row.strength, row.form, row.route].join("|").toLowerCase();
    const twin = seen.get(key);
    if (twin)
      issues.push(`The same product as ${twin}`);
    else
      seen.set(key, code);
    rows.push(row);
    for (const issue of issues)
      review.push({ code, display, included: true, issue });
  }
  return { rows, review };
}

/** A CSV field, quoted when it holds a comma, a quote or a line break. */
function field(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll("\"", "\"\"")}"` : value;
}

/** The catalogue's load file (`lib/drug-catalogue-load.ts`). */
export function drugsCsv(rows: DrugRow[]): string {
  const lines = rows.map(r => [r.code, r.genericName, r.strength, r.form, r.doseUnit, r.route, r.controlledSchedule ?? ""].map(field).join(","));
  return `${["code,generic_name,strength,form,dose_unit,route,controlled_schedule", ...lines].join("\n")}\n`;
}

/**
 * A cell a spreadsheet would run as a formula (= + - @, or a tab or return
 * first), made plain text with a leading apostrophe. Only the review list, which
 * a person opens, needs it; the load file is read by the loader alone.
 */
function inert(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** The review list, one issue a line. */
export function reviewCsv(review: ReviewItem[]): string {
  const lines = review.map(r => [r.code, r.display, r.included ? "yes" : "no", r.issue].map(v => field(inert(v))).join(","));
  return `${["code,name,in_catalogue,issue", ...lines].join("\n")}\n`;
}
