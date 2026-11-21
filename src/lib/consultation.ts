import { and, desc, eq, inArray, lt, ne } from "drizzle-orm";

import type { AppDb } from "@/db";

import { encounters, memberships, patientNumbers, patients, queueEntries, servicePoints, user } from "@/db/schema";

import type { ShownAllergy } from "./allergies";
import type { ShownDiagnosis } from "./diagnoses";
import type { EncounterResults, ShownResult } from "./lab-results";
import type { ShownNote } from "./notes";
import type { ShownObservation } from "./observations";
import type { ShownOrder } from "./orders";
import type { PatientActor } from "./patients";
import type { Reader } from "./sensitivity";

import { allergiesOf } from "./allergies";
import { recordAudit } from "./audit";
import { diagnosesSeen } from "./diagnoses";
import { resultsSeen } from "./lab-results";
import { notesSeen } from "./notes";
import { observationsOf } from "./observations";
import { ordersSeen } from "./orders";
import { alertRecorders, categoriesOf, clinicCategoriesOf, isRestricted, readDetail, readerOf, sight } from "./sensitivity";

/**
 * The consultation (decided 2026-11-20, after the staff walkthrough): what the
 * doctor needs at once about the patient in front of them, in one read and
 * one audit entry, and today's complaint, recorded at triage. Earlier visits
 * and old results stay behind their own reads, one press away.
 */

export class ConsultationError extends Error {
  constructor(readonly code: "not_found" | "not_open") {
    super({
      not_found: "No such encounter",
      not_open: "This visit is no longer open",
    }[code]);
    this.name = "ConsultationError";
  }
}

export interface Complaint {
  text: string;
  recordedAt: Date;
  recordedBy: { membershipId: string; name: string };
}

async function complaintOf(tx: AppDb, encounterId: string): Promise<Complaint | null> {
  const [found] = await tx
    .select({ text: encounters.complaint, recordedAt: encounters.complaintRecordedAt, membershipId: encounters.complaintRecordedBy, name: user.name })
    .from(encounters)
    .leftJoin(memberships, eq(memberships.id, encounters.complaintRecordedBy))
    .leftJoin(user, eq(user.id, memberships.userId))
    .where(eq(encounters.id, encounterId))
    .limit(1);
  if (!found?.text)
    return null;
  return { text: found.text, recordedAt: found.recordedAt!, recordedBy: { membershipId: found.membershipId!, name: found.name! } };
}

/**
 * Records why the patient came today, or corrects it, while the visit is
 * open. Each change is audited with the old text. In a sensitive clinic's
 * visit, only someone who may see the complaint changes it (rule 27).
 */
export async function recordComplaint(
  tx: AppDb,
  facilityId: string,
  encounterId: string,
  text: string,
  actor: PatientActor,
  at = new Date(),
): Promise<Complaint> {
  const [encounter] = await tx
    .select({ patientId: encounters.patientId, status: encounters.status, complaint: encounters.complaint, recordedBy: encounters.complaintRecordedBy })
    .from(encounters)
    .where(eq(encounters.id, encounterId))
    .for("update")
    .limit(1);
  if (!encounter)
    throw new ConsultationError("not_found");
  if (encounter.status !== "open")
    throw new ConsultationError("not_open");

  if (encounter.complaint !== null) {
    const clinics = (await clinicCategoriesOf(tx, [encounterId])).get(encounterId);
    const guard = { categories: categoriesOf(clinics), recordedBy: [encounter.recordedBy] };
    if (await isRestricted(tx, { facilityId, patientId: encounter.patientId, encounterId }, guard, actor))
      throw new ConsultationError("not_found");
  }

  if (encounter.complaint !== text) {
    await tx.update(encounters)
      .set({ complaint: text, complaintRecordedAt: at, complaintRecordedBy: actor.membershipId })
      .where(eq(encounters.id, encounterId));
    await recordAudit(tx, {
      facilityId,
      actorId: actor.userId,
      action: "encounter.complaint_recorded",
      entityType: "encounter",
      entityId: encounterId,
      summary: encounter.complaint === null ? "Recorded today's complaint" : "Corrected today's complaint",
      detail: { from: encounter.complaint, to: text },
    });
  }

  return (await complaintOf(tx, encounterId))!;
}

/** The visit before this one, in short: what a doctor glances at for a chronic patient. */
export interface LastVisit {
  encounterId: string;
  startedAt: Date;
  /** Its clinic is sensitive and the reader may not see it (rule 27): only the date is shown. */
  restricted: boolean;
  clinic: string | null;
  /** Its standing diagnoses, by name. */
  diagnoses: string[];
  /** The medicines prescribed, as prescribed. */
  medicines: string[];
}

export interface Consultation {
  encounter: { id: string; kind: "opd" | "emergency" | "ipd"; status: "open" | "closed" | "cancelled"; startedAt: Date };
  patient: {
    id: string;
    opNumber: string | null;
    givenName: string;
    middleNames: string | null;
    familyName: string;
    sex: "male" | "female" | "intersex" | null;
    dateOfBirth: string;
  };
  complaint: Complaint | null;
  vitals: ShownObservation[];
  allergies: ShownAllergy[];
  notes: ShownNote[];
  diagnoses: ShownDiagnosis[];
  orders: ShownOrder[];
  results: ShownResult[];
  reports: EncounterResults["reports"];
  /** Everything withheld from the reader (rule 27), by date only. */
  restricted: { recordedAt: Date }[];
  lastVisit: LastVisit | null;
}

interface Seen {
  restricted: { recordedAt: Date }[];
  viaGrant: string | null;
  viaGrantRecorders: readonly (string | null)[];
}

/** Today's complaint as `reader` may see it: like a note, hidden with the rest of a sensitive clinic's visit. */
async function complaintSeen(tx: AppDb, encounterId: string, reader: Reader): Promise<Seen & { shown: Complaint | null }> {
  const complaint = await complaintOf(tx, encounterId);
  if (!complaint)
    return { shown: null, restricted: [], viaGrant: null, viaGrantRecorders: [] };
  const clinics = (await clinicCategoriesOf(tx, [encounterId])).get(encounterId);
  const seen = sight(reader, { categories: categoriesOf(clinics), recordedBy: [complaint.recordedBy.membershipId] });
  if (seen === "restricted")
    return { shown: null, restricted: [{ recordedAt: complaint.recordedAt }], viaGrant: null, viaGrantRecorders: [] };
  if (seen === "via_grant")
    return { shown: complaint, restricted: [], viaGrant: reader.grantId, viaGrantRecorders: [complaint.recordedBy.membershipId] };
  return { shown: complaint, restricted: [], viaGrant: null, viaGrantRecorders: [] };
}

async function lastVisitOf(
  tx: AppDb,
  encounter: { id: string; patientId: string; startedAt: Date },
  reader: Reader,
): Promise<{ visit: LastVisit; seen: Seen } | null> {
  const [previous] = await tx
    .select({ id: encounters.id, startedAt: encounters.startedAt })
    .from(encounters)
    .where(and(
      eq(encounters.patientId, encounter.patientId),
      inArray(encounters.kind, ["opd", "emergency"]),
      ne(encounters.status, "cancelled"),
      lt(encounters.startedAt, encounter.startedAt),
      ne(encounters.id, encounter.id),
    ))
    .orderBy(desc(encounters.startedAt), desc(encounters.id))
    .limit(1);
  if (!previous)
    return null;

  // A sensitive clinic's name alone discloses (rule 27), so a visit to one the reader may not see shows its date only.
  // Every point the visit queued at is read in one statement, so the name shown is always one the check covered:
  // a queue entry committed between two reads could otherwise bring a sensitive clinic's name past it.
  const points = await tx
    .select({ name: servicePoints.name, kind: servicePoints.kind, category: servicePoints.sensitiveCategory })
    .from(queueEntries)
    .innerJoin(servicePoints, eq(servicePoints.id, queueEntries.servicePointId))
    .where(eq(queueEntries.encounterId, previous.id))
    .orderBy(desc(queueEntries.joinedAt), desc(queueEntries.id));
  const visitSight = sight(reader, { categories: categoriesOf(points.map(p => p.category)), recordedBy: [] });
  if (visitSight === "restricted") {
    return {
      visit: { encounterId: previous.id, startedAt: previous.startedAt, restricted: true, clinic: null, diagnoses: [], medicines: [] },
      seen: { restricted: [], viaGrant: null, viaGrantRecorders: [] },
    };
  }

  const clinic = points.find(p => p.kind === "consultation");
  const diagnoses = await diagnosesSeen(tx, previous.id, reader);
  const orders = await ordersSeen(tx, previous.id, reader);

  return {
    visit: {
      encounterId: previous.id,
      startedAt: previous.startedAt,
      restricted: false,
      clinic: clinic?.name ?? null,
      diagnoses: diagnoses.shown.filter(d => d.endedAt === null).map(d => d.title),
      medicines: orders.shown.flatMap(o => o.items).filter(i => i.kind === "medication" && i.status !== "cancelled").map(i => i.name),
    },
    seen: {
      restricted: [...diagnoses.restricted, ...orders.restricted],
      viaGrant: (visitSight === "via_grant" ? reader.grantId : null) ?? diagnoses.viaGrant ?? orders.viaGrant,
      viaGrantRecorders: [...diagnoses.viaGrantRecorders, ...orders.viaGrantRecorders],
    },
  };
}

/**
 * The patient in front of the doctor: who they are, today's vital signs,
 * allergies and complaint, this visit's notes, diagnoses, orders and
 * results, and the last visit in short. Each part is withheld as its own
 * read withholds it (rule 27), and the whole is audited once (rule 9).
 */
export async function viewConsultation(tx: AppDb, facilityId: string, encounterId: string, actor: PatientActor): Promise<Consultation> {
  const [encounter] = await tx
    .select({ id: encounters.id, patientId: encounters.patientId, kind: encounters.kind, status: encounters.status, startedAt: encounters.startedAt })
    .from(encounters)
    .where(eq(encounters.id, encounterId))
    .limit(1);
  if (!encounter)
    throw new ConsultationError("not_found");

  const [patient] = await tx
    .select({
      id: patients.id,
      opNumber: patientNumbers.number,
      givenName: patients.givenName,
      middleNames: patients.middleNames,
      familyName: patients.familyName,
      sex: patients.sex,
      dateOfBirth: patients.dateOfBirth,
    })
    .from(patients)
    .leftJoin(patientNumbers, and(eq(patientNumbers.patientId, patients.id), eq(patientNumbers.kind, "outpatient")))
    .where(eq(patients.id, encounter.patientId))
    .limit(1);

  const reader = await readerOf(tx, encounter.patientId, actor);
  const notes = await notesSeen(tx, encounterId, reader, actor);
  const diagnoses = await diagnosesSeen(tx, encounterId, reader);
  const orders = await ordersSeen(tx, encounterId, reader);
  const results = await resultsSeen(tx, encounterId, reader);
  const last = await lastVisitOf(tx, encounter, reader);
  const complaint = await complaintSeen(tx, encounterId, reader);
  const parts: Seen[] = [notes, diagnoses, orders, results, complaint, ...(last ? [last.seen] : [])];

  const restricted = parts.flatMap(p => p.restricted).sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
  const viaGrant = parts.find(p => p.viaGrant)?.viaGrant ?? null;
  await alertRecorders(tx, facilityId, viaGrant, parts.flatMap(p => p.viaGrantRecorders), actor);
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "encounter.viewed",
    entityType: "encounter",
    entityId: encounterId,
    summary: "Viewed the consultation",
    detail: { ...readDetail({ restricted, viaGrant }), ...(last ? { lastVisitId: last.visit.encounterId } : {}) },
  });

  return {
    encounter: { id: encounter.id, kind: encounter.kind, status: encounter.status, startedAt: encounter.startedAt },
    patient,
    complaint: complaint.shown,
    vitals: await observationsOf(tx, encounterId),
    allergies: await allergiesOf(tx, encounter.patientId),
    notes: notes.shown,
    diagnoses: diagnoses.shown,
    orders: orders.shown,
    results: results.results,
    reports: results.reports,
    restricted,
    lastVisit: last?.visit ?? null,
  };
}
