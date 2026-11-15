import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";

import type { AppDb } from "@/db";
import type { MembershipRole } from "@/db/schema";

import { drugCatalogue, sensitiveDrugs } from "@/db/schema";

import type { PatientActor } from "./patients";

import { recordAudit } from "./audit";

/**
 * The catalogue drugs whose prescriptions disclose a condition here (P4
 * slice 3c, decided 2026-11-15). Nothing is shipped: the facility marks
 * them, from the pilot clinician's list. The restriction itself is in
 * `orderGuards` (lib/sensitivity.ts), so every place an order is shown or
 * printed follows a mark at once, past prescriptions included.
 */

export type SensitiveCategory = "hiv" | "mental_health" | "gbv";

/** Who marks a drug sensitive. */
export const DRUG_MARKERS = ["facility_admin", "pharmacist"] as const satisfies readonly MembershipRole[];

export class SensitiveDrugError extends Error {
  constructor(readonly code: "drug_not_found") {
    super("No such drug in the catalogue");
    this.name = "SensitiveDrugError";
  }
}

export interface ShownSensitiveDrug {
  drugCode: string;
  genericName: string;
  strength: string;
  form: string;
  category: SensitiveCategory;
}

/** Marks a catalogue drug sensitive, changes its category, or unmarks it (null). Audited with the old and new category. */
export async function setDrugSensitivity(tx: AppDb, facilityId: string, drugCode: string, category: SensitiveCategory | null, actor: PatientActor): Promise<void> {
  const [drug] = await tx.select({ code: drugCatalogue.code, retiredAt: drugCatalogue.retiredAt }).from(drugCatalogue).where(eq(drugCatalogue.code, drugCode)).limit(1);
  if (!drug)
    throw new SensitiveDrugError("drug_not_found");
  const [before] = await tx.select({ category: sensitiveDrugs.category }).from(sensitiveDrugs).where(eq(sensitiveDrugs.drugCode, drug.code)).for("update").limit(1);
  if ((before?.category ?? null) === category)
    return;

  await tx.insert(sensitiveDrugs)
    .values({ facilityId, drugCode: drug.code, category, markedBy: actor.membershipId })
    .onConflictDoUpdate({ target: [sensitiveDrugs.facilityId, sensitiveDrugs.drugCode], set: { category, markedBy: actor.membershipId, markedAt: new Date() } });
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "drug.sensitivity_set",
    entityType: "drug",
    summary: category ? `Marked ${drug.code} sensitive (${category})` : `Unmarked ${drug.code}`,
    detail: { drugCode: drug.code, before: before?.category ?? null, after: category },
  });
}

/** The drugs marked sensitive here, by generic name. Not patient data, so not audited. */
export async function listSensitiveDrugs(tx: AppDb): Promise<ShownSensitiveDrug[]> {
  const rows = await tx
    .select({ drugCode: sensitiveDrugs.drugCode, genericName: drugCatalogue.genericName, strength: drugCatalogue.strength, form: drugCatalogue.form, category: sensitiveDrugs.category })
    .from(sensitiveDrugs)
    .innerJoin(drugCatalogue, eq(drugCatalogue.code, sensitiveDrugs.drugCode))
    .where(and(isNotNull(sensitiveDrugs.category), isNull(drugCatalogue.retiredAt)))
    .orderBy(asc(drugCatalogue.genericName), asc(drugCatalogue.strength));
  return rows.map(r => ({ ...r, category: r.category! }));
}
