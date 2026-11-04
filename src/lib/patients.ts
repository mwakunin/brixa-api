import type { SQL } from "drizzle-orm";

import { and, asc, eq, exists, inArray, or, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { patientIdentifiers, patientNumbers, patients } from "@/db/schema";

import { recordAudit } from "./audit";
import { issueNumber } from "./number-series";
import { normalizePhone } from "./phone";

/**
 * The patient register (SCHEMA.md §5): registration, search, viewing and
 * corrections. Every function takes the request's tenant transaction, so RLS
 * keeps each facility's register its own, and each read or change is audited
 * in the same transaction (rule 9).
 */

type PatientRow = typeof patients.$inferSelect;
export type Sex = NonNullable<PatientRow["sex"]>;
export type IdentifierType = (typeof patientIdentifiers.$inferSelect)["type"];

/** Who is acting: the person and their membership here. */
export interface PatientActor {
  userId: string;
  membershipId: string;
}

/** The documents that satisfy "an ID" at registration. */
export const IDENTITY_DOCUMENTS = ["national_id", "passport", "birth_certificate", "alien_id", "refugee_id"] as const;

export type DuplicateReason = "same_id" | "same_name_and_phone" | "same_name_and_birth_date";

export interface PatientSummary {
  id: string;
  opNumber: string | null;
  givenName: string;
  middleNames: string | null;
  familyName: string;
  sex: Sex | null;
  dateOfBirth: string;
  phone: string | null;
}

export class PatientError extends Error {
  constructor(
    readonly code: "not_found" | "possible_duplicate",
    readonly candidates: (PatientSummary & { reasons: DuplicateReason[] })[] = [],
  ) {
    super(code === "not_found" ? "No such patient" : "This looks like a patient already on file");
    this.name = "PatientError";
  }
}

/** Uppercase, no spaces or dots: `12 345 678` and `12345678` are one number. */
export function normalizeIdentifier(value: string): string {
  return value.toUpperCase().replace(/[\s.]/g, "");
}

const summaryColumns = {
  id: patients.id,
  opNumber: patientNumbers.number,
  givenName: patients.givenName,
  middleNames: patients.middleNames,
  familyName: patients.familyName,
  sex: patients.sex,
  dateOfBirth: patients.dateOfBirth,
  phone: patients.phone,
};

/** Patients with their OP number, filtered by `where`. */
function summaries(tx: AppDb, where: SQL | undefined, limit: number) {
  return tx
    .select(summaryColumns)
    .from(patients)
    .leftJoin(patientNumbers, and(
      eq(patientNumbers.patientId, patients.id),
      eq(patientNumbers.kind, "outpatient"),
    ))
    .where(where)
    .orderBy(asc(sql`lower(${patients.familyName})`), asc(sql`lower(${patients.givenName})`), asc(patients.id))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------

/**
 * Patients already on file who are probably this person: the same identity
 * number, the same family name and phone, or the same names and date of
 * birth. A warning, never a block: phones are shared and IDs mistyped.
 */
export async function likelyDuplicates(
  tx: AppDb,
  person: {
    givenName: string;
    familyName: string;
    dateOfBirth: string;
    phone: string | null;
    identifiers: { type: IdentifierType; value: string }[];
  },
  excludeId?: string,
): Promise<(PatientSummary & { reasons: DuplicateReason[] })[]> {
  const reasons = new Map<string, Set<DuplicateReason>>();
  const note = (ids: string[], reason: DuplicateReason) => {
    for (const id of ids) {
      if (id !== excludeId)
        reasons.set(id, (reasons.get(id) ?? new Set()).add(reason));
    }
  };

  if (person.identifiers.length > 0) {
    const rows = await tx
      .selectDistinct({ id: patientIdentifiers.patientId })
      .from(patientIdentifiers)
      .where(or(...person.identifiers.map(i => and(eq(patientIdentifiers.type, i.type), eq(patientIdentifiers.value, i.value)))));
    note(rows.map(r => r.id), "same_id");
  }

  const sameFamily = sql`lower(${patients.familyName}) = lower(${person.familyName})`;
  if (person.phone) {
    const rows = await tx.select({ id: patients.id }).from(patients).where(and(eq(patients.phone, person.phone), sameFamily));
    note(rows.map(r => r.id), "same_name_and_phone");
  }

  const sameNamesAndBirth = await tx.select({ id: patients.id }).from(patients).where(and(
    sameFamily,
    sql`lower(${patients.givenName}) = lower(${person.givenName})`,
    eq(patients.dateOfBirth, person.dateOfBirth),
  ));
  note(sameNamesAndBirth.map(r => r.id), "same_name_and_birth_date");

  if (reasons.size === 0)
    return [];

  const found = await summaries(tx, inArray(patients.id, [...reasons.keys()]), 5);
  return found.map(p => ({ ...p, reasons: [...reasons.get(p.id)!] }));
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface Registration {
  givenName: string;
  middleNames?: string | null;
  familyName: string;
  sex: Sex | null;
  dateOfBirth: string;
  dobIsEstimated: boolean;
  phone: string | null;
  noPhoneReason: PatientRow["noPhoneReason"];
  identifiers: { type: IdentifierType; value: string }[];
  noIdReason: PatientRow["noIdReason"];
  unidentified: boolean;
  /** The clerk has seen the likely duplicates and says this is someone else. */
  confirmNotDuplicate?: boolean;
}

/**
 * Registers a patient and issues their OP number, in one transaction: a
 * failed registration spends no number (SCHEMA.md §6).
 */
export async function registerPatient(
  tx: AppDb,
  facilityId: string,
  input: Registration,
  actor: PatientActor,
): Promise<{ id: string; opNumber: string }> {
  const identifiers = input.identifiers.map(i => ({ type: i.type, value: normalizeIdentifier(i.value) }));

  if (!input.confirmNotDuplicate) {
    const candidates = await likelyDuplicates(tx, { ...input, identifiers });
    if (candidates.length > 0)
      throw new PatientError("possible_duplicate", candidates);
  }

  const [patient] = await tx.insert(patients).values({
    facilityId,
    givenName: input.givenName,
    middleNames: input.middleNames || null,
    familyName: input.familyName,
    dateOfBirth: input.dateOfBirth,
    dobIsEstimated: input.dobIsEstimated,
    sex: input.sex,
    phone: input.phone,
    noPhoneReason: input.noPhoneReason,
    noIdReason: input.noIdReason,
    unidentified: input.unidentified,
    registeredBy: actor.membershipId,
  }).returning({ id: patients.id });

  const opNumber = await issueNumber(tx, facilityId, "outpatient");
  await tx.insert(patientNumbers).values({ facilityId, patientId: patient.id, kind: "outpatient", number: opNumber });

  if (identifiers.length > 0) {
    await tx.insert(patientIdentifiers).values(identifiers.map(i => ({
      facilityId,
      patientId: patient.id,
      type: i.type,
      value: i.value,
      addedBy: actor.membershipId,
    })));
  }

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "patient.registered",
    entityType: "patient",
    entityId: patient.id,
    summary: `Registered ${opNumber}`,
    detail: { opNumber, duplicateWarningOverridden: Boolean(input.confirmNotDuplicate) },
  });

  return { id: patient.id, opNumber };
}

// ---------------------------------------------------------------------------
// Search and viewing
// ---------------------------------------------------------------------------

/** LIKE treats `%`, `_` and `\` as syntax; a name typed with one means it literally. */
function likePrefix(token: string): string {
  return `${token.replace(/[\\%_]/g, c => `\\${c}`)}%`;
}

/**
 * Finds patients by OP or IP number, phone, identity number, or names (each
 * word typed matches the start of one of the patient's names), in name
 * order. At most 20: a search is for finding one person, not for listing the
 * register.
 */
export async function searchPatients(
  tx: AppDb,
  facilityId: string,
  query: string,
  actor: PatientActor,
): Promise<PatientSummary[]> {
  const q = query.trim();
  const matches: SQL[] = [
    exists(tx.select({ one: sql`1` }).from(patientNumbers).where(and(
      eq(patientNumbers.patientId, patients.id),
      sql`upper(${patientNumbers.number}) = ${q.toUpperCase()}`,
    ))),
    exists(tx.select({ one: sql`1` }).from(patientIdentifiers).where(and(
      eq(patientIdentifiers.patientId, patients.id),
      eq(patientIdentifiers.value, normalizeIdentifier(q)),
    ))),
  ];

  const phone = normalizePhone(q);
  if (phone)
    matches.push(eq(patients.phone, phone));

  const words = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 4);
  if (words.length > 0) {
    matches.push(and(...words.map(word => or(
      sql`lower(${patients.givenName}) LIKE ${likePrefix(word)}`,
      sql`lower(${patients.middleNames}) LIKE ${likePrefix(word)}`,
      sql`lower(${patients.familyName}) LIKE ${likePrefix(word)}`,
    )))!);
  }

  const results = await summaries(tx, or(...matches), 20);

  // Who searched for what (rule 9): the query, which is the patient detail
  // typed, stays in the database like the rest of the record.
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "patient.searched",
    entityType: "patient",
    summary: `Searched the register (${results.length} found)`,
    detail: { query: q, results: results.length },
  });

  return results;
}

export interface PatientRecord extends Omit<PatientRow, "facilityId" | "registeredBy" | "updatedAt"> {
  numbers: { kind: "outpatient" | "inpatient"; number: string; issuedAt: Date }[];
  identifiers: { type: IdentifierType; value: string; addedAt: Date }[];
}

/**
 * A patient's record, unaudited: for answering the act that just wrote it
 * (registration is audited as such). Opening a record is `viewPatient`.
 */
export async function patientRecord(tx: AppDb, id: string): Promise<PatientRecord | null> {
  return load(tx, id);
}

async function load(tx: AppDb, id: string): Promise<PatientRecord | null> {
  const [patient] = await tx.select().from(patients).where(eq(patients.id, id)).limit(1);
  if (!patient)
    return null;

  const numbers = await tx
    .select({ kind: patientNumbers.kind, number: patientNumbers.number, issuedAt: patientNumbers.issuedAt })
    .from(patientNumbers)
    .where(eq(patientNumbers.patientId, id))
    .orderBy(asc(patientNumbers.issuedAt));
  const identifiers = await tx
    .select({ type: patientIdentifiers.type, value: patientIdentifiers.value, addedAt: patientIdentifiers.addedAt })
    .from(patientIdentifiers)
    .where(eq(patientIdentifiers.patientId, id))
    .orderBy(asc(patientIdentifiers.addedAt));

  const { facilityId: _f, registeredBy: _r, updatedAt: _u, ...rest } = patient;
  return { ...rest, numbers, identifiers };
}

/** A patient's record, and an audit entry saying who opened it (rule 9). */
export async function viewPatient(tx: AppDb, facilityId: string, id: string, actor: PatientActor): Promise<PatientRecord> {
  const record = await load(tx, id);
  if (!record)
    throw new PatientError("not_found");

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "patient.viewed",
    entityType: "patient",
    entityId: id,
    summary: `Opened ${record.numbers[0]?.number ?? "a patient record"}`,
  });

  return record;
}

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

export type DemographicChanges = Partial<Pick<
  PatientRow,
  "givenName" | "middleNames" | "familyName" | "dateOfBirth" | "dobIsEstimated" | "sex" | "phone" | "noPhoneReason" | "noIdReason" | "unidentified"
>>;

/**
 * Corrects demographics, auditing each changed field's old and new value.
 * A phone added clears the reason there was none. The database refuses a
 * combination that breaks a rule (no sex unless unidentified, a phone and a
 * reason at once), which the route reports as a 422.
 */
export async function updatePatient(
  tx: AppDb,
  facilityId: string,
  id: string,
  changes: DemographicChanges,
  actor: PatientActor,
): Promise<PatientRecord> {
  const [current] = await tx.select().from(patients).where(eq(patients.id, id)).for("update").limit(1);
  if (!current)
    throw new PatientError("not_found");

  const next = { ...changes };
  if (next.phone)
    next.noPhoneReason = null;

  const changed = Object.fromEntries(
    Object.entries(next).filter(([field, value]) => current[field as keyof PatientRow] !== value),
  ) as DemographicChanges;

  if (Object.keys(changed).length > 0) {
    await tx.update(patients).set(changed).where(eq(patients.id, id));
    await recordAudit(tx, {
      facilityId,
      actorId: actor.userId,
      action: "patient.updated",
      entityType: "patient",
      entityId: id,
      summary: `Corrected ${Object.keys(changed).join(", ")}`,
      detail: Object.fromEntries(Object.entries(changed).map(([field, to]) => [
        field,
        { from: current[field as keyof PatientRow] ?? null, to: to ?? null },
      ])),
    });
  }

  return (await load(tx, id))!;
}

/**
 * Adds an identifier, warning first if another patient already has it. An
 * identity document clears the reason the patient had none.
 */
export async function addIdentifier(
  tx: AppDb,
  facilityId: string,
  id: string,
  input: { type: IdentifierType; value: string; confirmNotDuplicate?: boolean },
  actor: PatientActor,
): Promise<PatientRecord> {
  const [current] = await tx.select().from(patients).where(eq(patients.id, id)).for("update").limit(1);
  if (!current)
    throw new PatientError("not_found");

  const value = normalizeIdentifier(input.value);
  if (!input.confirmNotDuplicate) {
    const holders = await tx
      .selectDistinct({ id: patientIdentifiers.patientId })
      .from(patientIdentifiers)
      .where(and(eq(patientIdentifiers.type, input.type), eq(patientIdentifiers.value, value)));
    const others = holders.map(h => h.id).filter(other => other !== id);
    if (others.length > 0) {
      const found = await summaries(tx, inArray(patients.id, others), 5);
      throw new PatientError("possible_duplicate", found.map(p => ({ ...p, reasons: ["same_id"] })));
    }
  }

  await tx.insert(patientIdentifiers)
    .values({ facilityId, patientId: id, type: input.type, value, addedBy: actor.membershipId })
    .onConflictDoNothing();

  if (current.noIdReason && (IDENTITY_DOCUMENTS as readonly string[]).includes(input.type))
    await tx.update(patients).set({ noIdReason: null }).where(eq(patients.id, id));

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "patient.identifier_added",
    entityType: "patient",
    entityId: id,
    summary: `Added a ${input.type.replaceAll("_", " ")}`,
    detail: { type: input.type, value },
  });

  return (await load(tx, id))!;
}
