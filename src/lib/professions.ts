/**
 * The professions whose members act clinically, and the council that
 * licenses each (CLAUDE.md rule 25).
 *
 * A member holds one practising licence, in their own profession, and may
 * hold roles of other professions under it: a nurse who also dispenses at
 * night is a nurse with the `pharm_tech` role. When their clinical roles all
 * belong to one profession, the profession is derived from them rather than
 * asked for (SPEC.md §7.9).
 *
 * Plain data with no imports: `db/schema.ts` builds the membership and
 * invitation CHECKs from it, so the database and the service cannot disagree
 * about which roles need a licence. `lib/practitioners.ts` checks that every
 * role named here is a membership role.
 */
export const PROFESSIONS = {
  medical_practitioner: {
    roles: ["doctor"],
    council: "KMPDC",
    councilName: "Kenya Medical Practitioners and Dentists Council",
  },
  clinical_officer: {
    roles: ["clinical_officer"],
    council: "COC",
    councilName: "Clinical Officers Council",
  },
  nurse: {
    roles: ["nurse", "ward_nurse"],
    council: "NCK",
    councilName: "Nursing Council of Kenya",
  },
  laboratory: {
    roles: ["lab_tech", "lab_supervisor"],
    council: "KMLTTB",
    councilName: "Kenya Medical Laboratory Technicians and Technologists Board",
  },
  pharmacy: {
    roles: ["pharmacist", "pharm_tech"],
    council: "PPB",
    councilName: "Pharmacy and Poisons Board",
  },
} as const;

export type Profession = keyof typeof PROFESSIONS;

export const PROFESSION_KEYS = Object.keys(PROFESSIONS) as [Profession, ...Profession[]];

export type ClinicalRole = (typeof PROFESSIONS)[Profession]["roles"][number];

/** Every role that needs a practising licence. */
export const CLINICAL_ROLES: readonly ClinicalRole[] = Object.values(PROFESSIONS).flatMap(p => p.roles);

/**
 * A licence number as the council printed it, made comparable: uppercase,
 * spaces and dots dropped (`nck 12.345` is `NCK12345`). The shape the
 * database allows after that, so the route and the CHECK agree.
 */
export const LICENCE_NUMBER_PATTERN = "^[A-Z0-9][A-Z0-9/-]{0,29}$";

/** The professions `roles` draw on, in `PROFESSIONS` order. */
export function professionsOf(roles: readonly string[]): Profession[] {
  return PROFESSION_KEYS.filter(p => (PROFESSIONS[p].roles as readonly string[]).some(r => roles.includes(r)));
}
