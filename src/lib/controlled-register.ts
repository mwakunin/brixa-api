import { and, asc, desc, eq, gte, lt } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { AppDb } from "@/db";
import type { MembershipRole } from "@/db/schema";

import { controlledDrugRegister, drugCatalogue, memberships, patientNumbers, patients, stockBatches, stores, user } from "@/db/schema";

import type { PatientActor } from "./patients";

import { recordAudit } from "./audit";
import { addDays, startOfBusinessDay } from "./dates";

/**
 * Reading the controlled-drug register (CLAUDE.md rule 12, P4 slice 4). A
 * trigger on the stock ledger writes it (migration 0093); this module only
 * shows a page of it: one catalogue drug in one store, over Kenyan days.
 * Its lines name patients, so a read is audited (rule 9).
 */

type RegisterRow = typeof controlledDrugRegister.$inferSelect;

/** Who reads the register: the pharmacist in charge, the facility admin, the auditor. */
export const REGISTER_READERS = ["pharmacist", "facility_admin", "auditor"] as const satisfies readonly MembershipRole[];

/** The most lines one read shows, oldest first: a narrower range shows the rest. */
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

/** One drug's page in one store, from and to Kenyan days (inclusive), audited. */
export async function viewRegister(
  tx: AppDb,
  facilityId: string,
  input: { drugCode: string; storeId: string; from?: string; to?: string },
  actor: PatientActor,
): Promise<RegisterPage> {
  const [drug] = await tx.select().from(drugCatalogue).where(eq(drugCatalogue.code, input.drugCode)).limit(1);
  if (!drug)
    throw new RegisterError("drug_not_found");
  const [store] = await tx.select({ id: stores.id, name: stores.name }).from(stores).where(eq(stores.id, input.storeId)).limit(1);
  if (!store)
    throw new RegisterError("store_not_found");

  const page = and(eq(controlledDrugRegister.storeId, store.id), eq(controlledDrugRegister.drugCode, drug.code));
  const from = input.from ? startOfBusinessDay(input.from) : undefined;
  const until = input.to ? startOfBusinessDay(addDays(input.to, 1)) : undefined;
  const [before] = from
    ? await tx.select({ balance: controlledDrugRegister.balance }).from(controlledDrugRegister).where(and(page, lt(controlledDrugRegister.recordedAt, from))).orderBy(desc(controlledDrugRegister.entry)).limit(1)
    : [];

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
    .limit(REGISTER_PAGE);

  const lines = rows.map((r): RegisterLine => ({
    at: r.line.recordedAt,
    kind: r.line.kind,
    batchNumber: r.batchNumber,
    expiresOn: r.expiresOn,
    quantityIn: Math.max(r.line.quantity, 0),
    quantityOut: Math.max(-r.line.quantity, 0),
    balance: r.line.balance,
    patient: r.line.patientId ? { id: r.line.patientId, name: [r.givenName, r.middleNames, r.familyName].filter(Boolean).join(" "), opNumber: r.opNumber } : null,
    prescriber: r.line.prescribedBy ? { name: r.prescriberName ?? "", licence: r.line.prescriberLicence } : null,
    recordedBy: r.line.recordedBy ? { name: r.recorderName ?? "", licence: r.line.recorderLicence } : null,
  }));

  const patientIds = [...new Set(rows.flatMap(r => (r.line.patientId ? [r.line.patientId] : [])))];
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "controlled_register.viewed",
    entityType: "store",
    entityId: store.id,
    summary: `Viewed the controlled-drug register for ${drug.code} (${lines.length} lines)`,
    detail: { drugCode: drug.code, from: input.from ?? null, to: input.to ?? null, patients: patientIds },
  });
  return {
    drug: { code: drug.code, genericName: drug.genericName, strength: drug.strength, form: drug.form, controlledSchedule: drug.controlledSchedule },
    store,
    balanceBefore: before?.balance ?? 0,
    lines,
  };
}
