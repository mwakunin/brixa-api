import { and, asc, eq, isNull, like, or, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { drugCatalogue } from "@/db/schema";

/**
 * The shared drug catalogue (SCHEMA.md §8, P3 slice 4b): medicines at
 * generic level, loaded per environment by `pnpm drugs:load`
 * (`lib/drug-catalogue-load.ts`). The app only reads it.
 */

export type Drug = typeof drugCatalogue.$inferSelect;
export type DrugRoute = Drug["route"];
export type ControlledSchedule = NonNullable<Drug["controlledSchedule"]>;

/** The catalogue's routes, in the column's order. */
export const DRUG_ROUTES = [
  "oral",
  "sublingual",
  "iv",
  "im",
  "sc",
  "intradermal",
  "topical",
  "rectal",
  "vaginal",
  "inhaled",
  "nasal",
  "ophthalmic",
  "otic",
] as const satisfies readonly DrugRoute[];

const SEARCH_LIMIT = 20;

export interface DrugMatch {
  code: string;
  genericName: string;
  strength: string;
  form: string;
  doseUnit: string;
  route: DrugRoute;
  controlledSchedule: ControlledSchedule | null;
}

/**
 * Current drugs whose generic name has a word starting with each word typed,
 * or whose code starts with what was typed. At most 20, by name and strength.
 */
export async function searchDrugs(tx: AppDb, q: string): Promise<DrugMatch[]> {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0)
    return [];
  const typed = q.trim().toUpperCase();
  const codeLike = /^[A-Z0-9][A-Z0-9._/-]*$/.test(typed) ? typed : null;

  return tx
    .select({
      code: drugCatalogue.code,
      genericName: drugCatalogue.genericName,
      strength: drugCatalogue.strength,
      form: drugCatalogue.form,
      doseUnit: drugCatalogue.doseUnit,
      route: drugCatalogue.route,
      controlledSchedule: drugCatalogue.controlledSchedule,
    })
    .from(drugCatalogue)
    .where(and(
      isNull(drugCatalogue.retiredAt),
      or(
        // Letters and digits only reach the pattern, so nothing typed is regex syntax.
        and(...words.map(w => sql`${drugCatalogue.genericName} ~* ${`\\m${w}`}`)),
        // `_` is a wildcard to LIKE; a code's underscore must match itself.
        codeLike ? like(drugCatalogue.code, `${codeLike.replaceAll("_", "\\_")}%`) : undefined,
      ),
    ))
    .orderBy(asc(drugCatalogue.genericName), asc(drugCatalogue.strength), asc(drugCatalogue.code))
    .limit(SEARCH_LIMIT);
}

/** A drug still in the catalogue, or null. */
export async function currentDrug(tx: AppDb, code: string): Promise<Drug | null> {
  const [drug] = await tx.select().from(drugCatalogue).where(and(eq(drugCatalogue.code, code), isNull(drugCatalogue.retiredAt))).limit(1);
  return drug ?? null;
}

/** How the drug is printed: `Paracetamol 500 mg Tablet`. */
export function describeDrug(drug: Pick<Drug, "genericName" | "strength" | "form">): string {
  return `${drug.genericName} ${drug.strength} ${drug.form}`;
}

/**
 * The generic names in a drug, compared without case: a combination's parts,
 * so an allergy to amoxicillin is found in amoxicillin/clavulanic acid.
 */
export function ingredientsOf(genericName: string): string[] {
  return genericName.split(/\s*[/+]\s*/).map(part => part.trim().toLowerCase()).filter(Boolean);
}
