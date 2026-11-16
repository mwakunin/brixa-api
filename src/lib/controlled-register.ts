import type { SQL } from "drizzle-orm";

import { and, asc, desc, eq, gt, gte, inArray, lt } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { AppDb } from "@/db";
import type { MembershipRole } from "@/db/schema";

import { breakGlassGrants, controlledDrugRegister, drugCatalogue, memberships, patientNumbers, patients, sensitiveDrugs, stockBatches, stores, user } from "@/db/schema";

import type { DispenseActor } from "./dispensing";
import type { SensitiveCategory } from "./sensitivity";

import { recordAudit } from "./audit";
import { addDays, startOfBusinessDay } from "./dates";
import { alertRecorders } from "./sensitivity";

/**
 * Reading the controlled-drug register (CLAUDE.md rule 12, P4 slice 4). A
 * trigger on the stock ledger writes it (migration 0093); this module only
 * shows a page of it: one catalogue drug in one store, over Kenyan days.
 * Its lines name patients, so a read is audited (rule 9); on a medicine the
 * facility marked sensitive, only to those who may see them (rule 27).
 */

type RegisterRow = typeof controlledDrugRegister.$inferSelect;

/** Who reads the register: the pharmacist in charge, the facility admin, the auditor. */
export const REGISTER_READERS = ["pharmacist", "facility_admin", "auditor"] as const satisfies readonly MembershipRole[];

/** The most lines one read shows, oldest first: `offset` shows the next. */
export const REGISTER_PAGE = 500;

export class RegisterError extends Error {
  constructor(readonly code: "drug_not_found" | "store_not_found") {
    super({ drug_not_found: "No such drug in the catalogue", store_not_found: "No such store" }[code]);
    this.name = "RegisterError";
  }
}

interface Person { name: string; licence: string | null }

export interface RegisterLine {
  at: Date;
  kind: RegisterRow["kind"];
  batchNumber: string | null;
  expiresOn: string | null;
  quantityIn: number;
  quantityOut: number;
  balance: number;
  patient: { id: string; name: string; opNumber: string | null } | null;
  /** A patient this reader may not see: the line of a sensitive medicine (rule 27). */
  patientHidden: boolean;
  prescriber: Person | null;
  recordedBy: Person | null;
}

export interface RegisterPage {
  drug: { code: string; genericName: string; strength: string; form: string; controlledSchedule: string | null };
  store: { id: string; name: string };
  /** The balance before the first day shown. */
  balanceBefore: number;
  lines: RegisterLine[];
}

const prescriber = alias(memberships, "prescriber");
const prescriberUser = alias(user, "prescriber_user");
const recorder = alias(memberships, "recorder");
const recorderUser = alias(user, "recorder_user");

/**
 * The balance before the first line shown: that line's balance less its
 * quantity, by entry order, never by time. With no line in the range, the
 * page's last balance before the range ends, which a page's dates follow
 * (each is written under its lock, migration 0094).
 */
async function balanceBefore(tx: AppDb, page: SQL | undefined, first: RegisterRow | undefined, until: Date | undefined): Promise<number> {
  if (first)
    return first.balance - first.quantity;
  const [last] = await tx.select({ balance: controlledDrugRegister.balance }).from(controlledDrugRegister).where(and(page, until ? lt(controlledDrugRegister.recordedAt, until) : undefined)).orderBy(desc(controlledDrugRegister.entry)).limit(1);
  return last?.balance ?? 0;
}

/**
 * Whose names this reader sees on a page (rule 27): every patient's, unless
 * the facility marked the medicine sensitive. Then the pharmacist keeping the
 * register, and a member given its category, see them all; anyone else sees
 * a patient only through their break-glass grant on that patient. Answers each
 * patient seen, with the grant it was seen through (null when seen openly).
 */
async function patientsShown(tx: AppDb, category: SensitiveCategory | null, patientIds: string[], actor: DispenseActor, at = new Date()): Promise<Map<string, string | null>> {
  const open = new Map(patientIds.map(id => [id, null]));
  if (!category || patientIds.length === 0 || actor.roles.includes("pharmacist"))
    return open;
  const [member] = await tx.select({ categories: memberships.sensitiveCategories }).from(memberships).where(eq(memberships.id, actor.membershipId)).limit(1);
  if (member?.categories.includes(category))
    return open;
  const grants = await tx
    .select({ patientId: breakGlassGrants.patientId, id: breakGlassGrants.id })
    .from(breakGlassGrants)
    .where(and(inArray(breakGlassGrants.patientId, patientIds), eq(breakGlassGrants.grantedTo, actor.membershipId), gt(breakGlassGrants.expiresAt, at)))
    .orderBy(asc(breakGlassGrants.expiresAt));
  return new Map(grants.map(g => [g.patientId, g.id]));
}

/** One drug's page in one store, from and to Kenyan days (inclusive), `REGISTER_PAGE` lines at a time, audited. */
export async function viewRegister(
  tx: AppDb,
  facilityId: string,
  input: { drugCode: string; storeId: string; from?: string; to?: string; offset?: number },
  actor: DispenseActor,
): Promise<RegisterPage> {
  const [drug] = await tx.select().from(drugCatalogue).where(eq(drugCatalogue.code, input.drugCode)).limit(1);
  if (!drug)
    throw new RegisterError("drug_not_found");
  const [store] = await tx.select({ id: stores.id, name: stores.name }).from(stores).where(eq(stores.id, input.storeId)).limit(1);
  if (!store)
    throw new RegisterError("store_not_found");
  const [marked] = await tx.select({ category: sensitiveDrugs.category }).from(sensitiveDrugs).where(eq(sensitiveDrugs.drugCode, drug.code)).limit(1);

  const page = and(eq(controlledDrugRegister.storeId, store.id), eq(controlledDrugRegister.drugCode, drug.code));
  const from = input.from ? startOfBusinessDay(input.from) : undefined;
  const until = input.to ? startOfBusinessDay(addDays(input.to, 1)) : undefined;

  const rows = await tx
    .select({
      line: controlledDrugRegister,
      batchNumber: stockBatches.batchNumber,
      expiresOn: stockBatches.expiresOn,
      givenName: patients.givenName,
      middleNames: patients.middleNames,
      familyName: patients.familyName,
      opNumber: patientNumbers.number,
      prescriberName: prescriberUser.name,
      recorderName: recorderUser.name,
    })
    .from(controlledDrugRegister)
    .leftJoin(stockBatches, eq(stockBatches.id, controlledDrugRegister.batchId))
    .leftJoin(patients, eq(patients.id, controlledDrugRegister.patientId))
    .leftJoin(patientNumbers, and(eq(patientNumbers.patientId, patients.id), eq(patientNumbers.kind, "outpatient")))
    .leftJoin(prescriber, eq(prescriber.id, controlledDrugRegister.prescribedBy))
    .leftJoin(prescriberUser, eq(prescriberUser.id, prescriber.userId))
    .leftJoin(recorder, eq(recorder.id, controlledDrugRegister.recordedBy))
    .leftJoin(recorderUser, eq(recorderUser.id, recorder.userId))
    .where(and(page, from ? gte(controlledDrugRegister.recordedAt, from) : undefined, until ? lt(controlledDrugRegister.recordedAt, until) : undefined))
    .orderBy(asc(controlledDrugRegister.entry))
    .limit(REGISTER_PAGE)
    .offset(input.offset ?? 0);

  const named = [...new Set(rows.flatMap(r => (r.line.patientId ? [r.line.patientId] : [])))];
  const shown = await patientsShown(tx, marked?.category ?? null, named, actor);
  const seen = (patientId: string | null) => patientId !== null && shown.has(patientId);

  const lines = rows.map((r): RegisterLine => ({
    at: r.line.recordedAt,
    kind: r.line.kind,
    batchNumber: r.batchNumber,
    expiresOn: r.expiresOn,
    quantityIn: Math.max(r.line.quantity, 0),
    quantityOut: Math.max(-r.line.quantity, 0),
    balance: r.line.balance,
    patient: seen(r.line.patientId) ? { id: r.line.patientId!, name: [r.givenName, r.middleNames, r.familyName].filter(Boolean).join(" "), opNumber: r.opNumber } : null,
    patientHidden: r.line.patientId !== null && !seen(r.line.patientId),
    prescriber: r.line.prescribedBy ? { name: r.prescriberName ?? "", licence: r.line.prescriberLicence } : null,
    recordedBy: r.line.recordedBy ? { name: r.recorderName ?? "", licence: r.line.recorderLicence } : null,
  }));

  const grants = [...new Set([...shown.values()].filter((g): g is string => g !== null))];
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "controlled_register.viewed",
    entityType: "store",
    entityId: store.id,
    summary: `Viewed the controlled-drug register for ${drug.code} (${lines.length} lines)`,
    detail: { drugCode: drug.code, from: input.from ?? null, to: input.to ?? null, patients: [...shown.keys()], ...(shown.size < named.length ? { hidden: named.length - shown.size } : {}), ...(grants.length > 0 ? { viaGrants: grants } : {}) },
  });
  // Those who dispensed what a grant opened are told, once per grant (rule 27).
  for (const grant of grants)
    await alertRecorders(tx, facilityId, grant, rows.filter(r => r.line.patientId && shown.get(r.line.patientId) === grant).map(r => r.line.recordedBy), actor);
  return {
    drug: { code: drug.code, genericName: drug.genericName, strength: drug.strength, form: drug.form, controlledSchedule: drug.controlledSchedule },
    store,
    balanceBefore: await balanceBefore(tx, page, rows[0]?.line, until),
    lines,
  };
}
