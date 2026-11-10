import { and, asc, eq, or, sql } from "drizzle-orm";

import type { AppDb } from "@/db";
import type { MembershipRole } from "@/db/schema";

import { memberships, user } from "@/db/schema";

import type { ClinicalRole, Profession } from "./professions";

import { recordAudit } from "./audit";
import { addDays, businessDate } from "./dates";
import { CLINICAL_ROLES, LICENCE_NUMBER_PATTERN, PROFESSIONS, professionsOf } from "./professions";

/**
 * Practising licences and roles: who may perform a clinical act (CLAUDE.md
 * rule 25), administered by the facility admin.
 *
 * A member holding any clinical role carries one licence, in their own
 * profession, and exercises every clinical role they hold under it. The admin
 * records it when inviting them, and renews it or changes their roles here. A
 * clinical act after the licence's last day is refused (`requireClinicalRole`),
 * and the staff list shows licences about to lapse, so a renewal is never a
 * surprise. There is no check against the national health worker registry
 * until AfyaConnect offers one (SPEC.md §10, question 4).
 */

type ProfessionColumn = NonNullable<(typeof memberships.$inferSelect)["licenceProfession"]>;
// Compile errors here name a role in PROFESSIONS that memberships lack, or a
// profession the column and PROFESSIONS disagree on.
const _rolesExist: ClinicalRole extends MembershipRole ? true : ClinicalRole = true;
const _sameProfessions: [Profession, ProfessionColumn] extends [ProfessionColumn, Profession] ? true : never = true;
void _rolesExist;
void _sameProfessions;

/** The admin is warned this many days before a licence lapses. */
export const LICENCE_WARNING_DAYS = 30;

export type LicenceState = "valid" | "expiring" | "expired";

export interface LicenceInput {
  /** Derived from the clinical roles when they belong to one profession. */
  profession?: Profession;
  number: string;
  /** The last Kenyan day it is valid, `YYYY-MM-DD`. */
  expiresOn: string;
}

export interface Licence {
  profession: Profession;
  number: string;
  expiresOn: string;
}

export type PractitionerErrorCode
  = | "not_found"
    | "licence_required"
    | "licence_not_needed"
    | "profession_required"
    | "profession_mismatch"
    | "licence_expired"
    | "licence_number_invalid"
    | "not_clinical"
    | "last_admin";

const MESSAGES: Record<PractitionerErrorCode, string> = {
  not_found: "No such member here",
  licence_required: "A clinical role needs the person's practising licence number and expiry date",
  licence_not_needed: "Only a clinical role carries a practising licence",
  profession_required: "These roles span professions; say which profession the licence is held in",
  profession_mismatch: "The licence must be in the profession of one of the clinical roles held",
  licence_expired: "That licence has already expired; enter the renewed one",
  licence_number_invalid: "A licence number has letters, digits, / and - only",
  not_clinical: "This member holds no clinical role, so has no licence to renew",
  last_admin: "This is the facility's last admin. Make someone else an admin first.",
};

export class PractitionerError extends Error {
  constructor(readonly code: PractitionerErrorCode) {
    super(MESSAGES[code]);
    this.name = "PractitionerError";
  }
}

export function isClinicalRole(role: MembershipRole): role is ClinicalRole {
  return (CLINICAL_ROLES as readonly string[]).includes(role);
}

/** Uppercase, spaces and dots dropped, as `memberships_licence_number_shape` expects. */
export function normaliseLicenceNumber(value: string): string {
  return value.toUpperCase().replace(/[\s.]/g, "");
}

/** Valid through its last day; expiring within the warning window. */
export function licenceState(expiresOn: string, today = businessDate()): LicenceState {
  if (expiresOn < today)
    return "expired";
  return expiresOn <= addDays(today, LICENCE_WARNING_DAYS) ? "expiring" : "valid";
}

/**
 * The licence `roles` call for, normalised, or null when they call for none.
 * Refuses a clinical role without one, one without a clinical role, and a
 * licence already lapsed today. The profession, when not given, is the one
 * profession the clinical roles belong to.
 */
export function licenceFor(
  roles: readonly MembershipRole[],
  licence: LicenceInput | null | undefined,
  today = businessDate(),
): Licence | null {
  if (!roles.some(isClinicalRole)) {
    if (licence)
      throw new PractitionerError("licence_not_needed");
    return null;
  }
  if (!licence)
    throw new PractitionerError("licence_required");
  return checkedLicence(licence, roles, today);
}

function checkedLicence(licence: LicenceInput, roles: readonly MembershipRole[], today: string): Licence {
  const derived = professionsOf(roles);
  const profession = licence.profession ?? (derived.length === 1 ? derived[0] : null);
  if (!profession)
    throw new PractitionerError("profession_required");
  // A licence covers roles of other professions only alongside one of its own
  // (a nurse who also dispenses), never instead of it (rule 25).
  if (!derived.includes(profession))
    throw new PractitionerError("profession_mismatch");
  const number = normaliseLicenceNumber(licence.number);
  if (!new RegExp(LICENCE_NUMBER_PATTERN).test(number))
    throw new PractitionerError("licence_number_invalid");
  if (licence.expiresOn < today)
    throw new PractitionerError("licence_expired");
  return { profession, number, expiresOn: licence.expiresOn };
}

export interface LicenceView extends Licence {
  council: string;
  councilName: string;
  state: LicenceState;
}

interface LicenceColumns {
  licenceProfession: Profession | null;
  licenceNumber: string | null;
  licenceExpiresOn: string | null;
}

/** A member's licence as staff see it, with its council and whether it is about to lapse. */
export function licenceView(member: LicenceColumns, today = businessDate()): LicenceView | null {
  const { licenceProfession: profession, licenceNumber: number, licenceExpiresOn: expiresOn } = member;
  if (!profession || !number || !expiresOn)
    return null;
  return {
    profession,
    council: PROFESSIONS[profession].council,
    councilName: PROFESSIONS[profession].councilName,
    number,
    expiresOn,
    state: licenceState(expiresOn, today),
  };
}

function licenceOf(member: LicenceColumns): Licence | null {
  const { licenceProfession: profession, licenceNumber: number, licenceExpiresOn: expiresOn } = member;
  return profession && number && expiresOn ? { profession, number, expiresOn } : null;
}

function licenceColumns(licence: Licence | null): LicenceColumns {
  return {
    licenceProfession: licence?.profession ?? null,
    licenceNumber: licence?.number ?? null,
    licenceExpiresOn: licence?.expiresOn ?? null,
  };
}

const memberColumns = {
  id: memberships.id,
  name: user.name,
  email: user.email,
  roles: memberships.roles,
  licenceProfession: memberships.licenceProfession,
  licenceNumber: memberships.licenceNumber,
  licenceExpiresOn: memberships.licenceExpiresOn,
};

type MemberRow = LicenceColumns & { id: string; name: string; email: string; roles: MembershipRole[] };

function present(row: MemberRow, today: string) {
  return { id: row.id, name: row.name, email: row.email, roles: row.roles, licence: licenceView(row, today) };
}

export type Member = ReturnType<typeof present>;

/**
 * The facility's active members, by name. Not capped: a facility's staff are
 * bounded by its size (a few hundred at a Level 4 hospital), and an admin must
 * see every licence about to lapse. RLS limits it to this facility.
 */
export async function listMembers(tx: AppDb, today = businessDate()): Promise<Member[]> {
  const rows = await tx
    .select(memberColumns)
    .from(memberships)
    .innerJoin(user, eq(user.id, memberships.userId))
    .where(eq(memberships.isActive, true))
    .orderBy(asc(user.name), asc(memberships.id));
  return rows.map(r => present(r, today));
}

/** An active member, locked. Only the membership row: the app role may not lock `user`. */
async function lockedMember(tx: AppDb, membershipId: string): Promise<MemberRow> {
  const [member] = await tx
    .select(memberColumns)
    .from(memberships)
    .innerJoin(user, eq(user.id, memberships.userId))
    .where(and(eq(memberships.id, membershipId), eq(memberships.isActive, true)))
    .for("update", { of: memberships })
    .limit(1);
  if (!member)
    throw new PractitionerError("not_found");
  return member;
}

/** Records a renewed (or corrected) licence, auditing the old and the new. */
export async function setLicence(
  tx: AppDb,
  facilityId: string,
  membershipId: string,
  licence: LicenceInput,
  actor: { userId: string },
  today = businessDate(),
): Promise<Member> {
  const member = await lockedMember(tx, membershipId);
  if (!member.roles.some(isClinicalRole))
    throw new PractitionerError("not_clinical");

  // A renewal keeps the profession unless it says otherwise.
  const renewed = checkedLicence({ ...licence, profession: licence.profession ?? member.licenceProfession ?? undefined }, member.roles, today);
  await tx.update(memberships).set(licenceColumns(renewed)).where(eq(memberships.id, membershipId));

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "membership.licence_changed",
    entityType: "membership",
    entityId: membershipId,
    summary: `Recorded ${member.email}'s licence ${renewed.number}, valid until ${renewed.expiresOn}`,
    detail: { before: licenceOf(member), after: renewed },
  });

  return present({ ...member, ...licenceColumns(renewed) }, today);
}

/**
 * Gives a member a new set of roles.
 *
 * Gaining a clinical role needs a licence, unless they already hold one that
 * fits the new roles; losing every clinical role clears it. The facility always keeps an admin:
 * every active admin membership is locked (by id) before the count, so two
 * admins demoting each other at once queue, and the second sees the first's
 * change and is refused.
 */
export async function changeRoles(
  tx: AppDb,
  facilityId: string,
  membershipId: string,
  input: { roles: MembershipRole[]; licence?: LicenceInput },
  actor: { userId: string },
  today = businessDate(),
): Promise<Member> {
  const locked = await tx
    .select({ id: memberships.id, roles: memberships.roles })
    .from(memberships)
    .where(and(
      eq(memberships.isActive, true),
      or(eq(memberships.id, membershipId), sql`${memberships.roles} @> ARRAY['facility_admin']::text[]`),
    ))
    .orderBy(asc(memberships.id))
    .for("update");

  const member = await lockedMember(tx, membershipId);
  const otherAdmins = locked.filter(m => m.id !== membershipId && m.roles.includes("facility_admin"));
  if (member.roles.includes("facility_admin") && !input.roles.includes("facility_admin") && otherAdmins.length === 0)
    throw new PractitionerError("last_admin");

  // The licence on record carries over only while it still fits the roles:
  // a nurse made a doctor needs a doctor's licence.
  const held = licenceOf(member);
  const heldFits = held !== null && professionsOf(input.roles).includes(held.profession);
  const licence = input.licence || !input.roles.some(isClinicalRole) || !heldFits
    ? licenceFor(input.roles, input.licence, today)
    : held;

  await tx
    .update(memberships)
    .set({ roles: input.roles, ...licenceColumns(licence), updatedAt: new Date() })
    .where(eq(memberships.id, membershipId));

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "membership.roles_changed",
    entityType: "membership",
    entityId: membershipId,
    summary: `Changed ${member.email}'s roles to ${input.roles.join(", ")}`,
    detail: {
      before: { roles: member.roles, licence: held },
      after: { roles: input.roles, licence },
    },
  });

  return present({ ...member, roles: input.roles, ...licenceColumns(licence) }, today);
}
