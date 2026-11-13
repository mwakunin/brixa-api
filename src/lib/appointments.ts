import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { AppDb } from "@/db";

import { appointments, encounters, memberships, patientNumbers, patients, servicePoints, user } from "@/db/schema";

import type { PatientActor } from "./patients";
import type { WorklistPatient } from "./worklist-patient";

import { queueReminder } from "./appointment-reminders";
import { recordAudit } from "./audit";
import { addDays, businessDate, businessTimeOfDay } from "./dates";
import { isUniqueViolation, pgConstraintName } from "./db-errors";
import { openEncounter } from "./encounters";
import { defaultTriagePoint, joinLocked, liveEntryOf, QueueError } from "./queues";
import { patientColumns, patientOf } from "./worklist-patient";

/**
 * Appointments (SCHEMA.md §8, P3 slice 6; decided 2026-11-13): a patient
 * booked at a clinic for a day, with a time and a clinician if wanted. No
 * slots or daily caps in v1: the day's list says how many are booked.
 *
 * Booked, then checked in on its own day or cancelled with a reason; moved
 * while booked. One still booked after its day was missed, derived and never
 * stored. Booking and moving schedule the SMS reminder for the day before
 * (lib/appointment-reminders.ts), sent only to a patient who said yes.
 *
 * Locks: the appointment first, then the encounter (M8 continues from there),
 * so a check-in and a cancellation of one appointment queue behind each
 * other. The clinic is share-locked while booked at, so retiring it (which
 * locks it, then counts what is booked there) waits for a booking, and a
 * booking for a retirement.
 */

type AppointmentRow = typeof appointments.$inferSelect;
export type AppointmentStatus = AppointmentRow["status"];

/** Who an appointment may be with. */
export const APPOINTMENT_CLINICIANS = ["doctor", "clinical_officer", "nurse"] as const;
/** How far ahead an appointment may be booked. */
export const BOOK_AHEAD_DAYS = 365;
/** At most this many in one day's list; more than a Level 4 hospital books a day. */
const DAY_LIST_LIMIT = 200;
/** At most this many in one page of a patient's appointments. */
const PATIENT_LIST_LIMIT = 50;

export type AppointmentErrorCode
  = | "appointment_not_found"
    | "patient_not_found"
    | "service_point_not_found"
    | "not_a_clinic"
    | "service_point_retired"
    | "not_a_clinician"
    | "in_the_past"
    | "too_far_ahead"
    | "already_booked"
    | "not_booked"
    | "not_today"
    | "sms_answer_needed";

export const APPOINTMENT_NOT_FOUND: ReadonlySet<AppointmentErrorCode> = new Set(["appointment_not_found", "patient_not_found", "service_point_not_found"]);

export class AppointmentError extends Error {
  constructor(readonly code: AppointmentErrorCode) {
    super({
      appointment_not_found: "No such appointment",
      patient_not_found: "No such patient",
      service_point_not_found: "No such clinic",
      not_a_clinic: "Appointments are booked at a clinic, not at triage",
      service_point_retired: "That clinic is out of use",
      not_a_clinician: "Book with a doctor, clinical officer or nurse working here",
      in_the_past: "That day or time has passed",
      too_far_ahead: `Book at most ${BOOK_AHEAD_DAYS} days ahead`,
      already_booked: "The patient is already booked at this clinic that day",
      not_booked: "This appointment has already been checked in or cancelled",
      not_today: "An appointment is checked in on its own day; move it to today first",
      sms_answer_needed: "Ask whether the patient wants SMS reminders, and give the answer",
    }[code]);
    this.name = "AppointmentError";
  }
}

/** `09:30` as stored; the database's `time` adds the seconds. */
const toColumn = (time: string | null | undefined) => (time ? `${time}:00` : null);
/** `09:30:00` as the API says it. */
export function toClock(time: string | null): string | null {
  return time?.slice(0, 5) ?? null;
}

async function lockAppointment(tx: AppDb, id: string): Promise<AppointmentRow> {
  const [appointment] = await tx.select().from(appointments).where(eq(appointments.id, id)).for("update").limit(1);
  if (!appointment)
    throw new AppointmentError("appointment_not_found");
  return appointment;
}

/** The clinic, share-locked so it cannot be retired under the booking. */
async function clinic(tx: AppDb, id: string) {
  const [point] = await tx.select().from(servicePoints).where(eq(servicePoints.id, id)).for("share").limit(1);
  if (!point)
    throw new AppointmentError("service_point_not_found");
  if (point.kind !== "consultation")
    throw new AppointmentError("not_a_clinic");
  if (!point.isActive)
    throw new AppointmentError("service_point_retired");
  return point;
}

async function mustBeClinician(tx: AppDb, membershipId: string): Promise<void> {
  const [member] = await tx
    .select({ roles: memberships.roles, isActive: memberships.isActive })
    .from(memberships)
    .where(eq(memberships.id, membershipId))
    .limit(1);
  if (!member?.isActive || !member.roles.some(r => (APPOINTMENT_CLINICIANS as readonly string[]).includes(r)))
    throw new AppointmentError("not_a_clinician");
}

/** From today (not a time already gone) to a year ahead. */
function checkWhen(date: string, time: string | null, at: Date): void {
  const today = businessDate(at);
  if (date < today || (date === today && time !== null && time < businessTimeOfDay(at)))
    throw new AppointmentError("in_the_past");
  if (date > addDays(today, BOOK_AHEAD_DAYS))
    throw new AppointmentError("too_far_ahead");
}

/** The encounter the patient is in now, newest first: a follow-up is booked during it. */
async function openEncounterOf(tx: AppDb, patientId: string): Promise<string | null> {
  const [open] = await tx
    .select({ id: encounters.id })
    .from(encounters)
    .where(and(eq(encounters.patientId, patientId), eq(encounters.status, "open")))
    .orderBy(desc(encounters.startedAt))
    .limit(1);
  return open?.id ?? null;
}

function slotTaken(err: unknown): boolean {
  return isUniqueViolation(err) && pgConstraintName(err) === "appointments_one_booked_per_clinic_day";
}

// ---------------------------------------------------------------------------
// The patient's answer to SMS reminders
// ---------------------------------------------------------------------------

/** Records whether the patient wants SMS reminders, audited with the old answer. */
export async function setSmsReminders(tx: AppDb, facilityId: string, patientId: string, wanted: boolean, actor: PatientActor, at = new Date()): Promise<boolean> {
  const [patient] = await tx
    .select({ smsReminders: patients.smsReminders })
    .from(patients)
    .where(eq(patients.id, patientId))
    .for("update")
    .limit(1);
  if (!patient)
    throw new AppointmentError("patient_not_found");
  if (patient.smsReminders === wanted)
    return wanted;

  await tx
    .update(patients)
    .set({ smsReminders: wanted, smsRemindersSetAt: at, smsRemindersSetBy: actor.membershipId })
    .where(eq(patients.id, patientId));
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "patient.sms_reminders_set",
    entityType: "patient",
    entityId: patientId,
    summary: wanted ? "Agreed to SMS reminders" : "Declined SMS reminders",
    detail: { from: patient.smsReminders, to: wanted },
  });
  return wanted;
}

// ---------------------------------------------------------------------------
// Booking, moving, cancelling, checking in
// ---------------------------------------------------------------------------

export interface Booking {
  patientId: string;
  servicePointId: string;
  clinicianId?: string;
  date: string;
  /** `HH:MM`, Kenyan time. */
  time?: string;
  /** The patient's answer to SMS reminders: needed the first time, for a patient with a phone. */
  smsReminders?: boolean;
}

export async function bookAppointment(tx: AppDb, facilityId: string, input: Booking, actor: PatientActor, at = new Date()): Promise<AppointmentRow> {
  const [patient] = await tx
    .select({ phone: patients.phone, smsReminders: patients.smsReminders })
    .from(patients)
    .where(eq(patients.id, input.patientId))
    .limit(1);
  if (!patient)
    throw new AppointmentError("patient_not_found");
  await clinic(tx, input.servicePointId);
  if (input.clinicianId)
    await mustBeClinician(tx, input.clinicianId);
  checkWhen(input.date, input.time ?? null, at);
  if (input.smsReminders === undefined && patient.phone && patient.smsReminders === null)
    throw new AppointmentError("sms_answer_needed");
  if (input.smsReminders !== undefined)
    await setSmsReminders(tx, facilityId, input.patientId, input.smsReminders, actor, at);

  let appointment: AppointmentRow;
  try {
    [appointment] = await tx.insert(appointments).values({
      facilityId,
      patientId: input.patientId,
      servicePointId: input.servicePointId,
      clinicianId: input.clinicianId ?? null,
      scheduledOn: input.date,
      scheduledTime: toColumn(input.time),
      bookedAt: at,
      bookedBy: actor.membershipId,
      bookedDuring: await openEncounterOf(tx, input.patientId),
    }).returning();
  }
  catch (err) {
    if (slotTaken(err))
      throw new AppointmentError("already_booked");
    throw err;
  }

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "appointment.booked",
    entityType: "appointment",
    entityId: appointment.id,
    summary: `Booked an appointment for ${input.date}`,
    detail: { patientId: input.patientId, servicePointId: input.servicePointId, clinicianId: input.clinicianId ?? null, date: input.date, time: input.time ?? null },
  });
  await queueReminder(tx, facilityId, appointment.id, appointment.scheduledOn, at);
  return appointment;
}

/** Moves a booked appointment to another day or time; the time is whatever the move gives. */
export async function moveAppointment(
  tx: AppDb,
  facilityId: string,
  id: string,
  input: { date: string; time?: string },
  actor: PatientActor,
  at = new Date(),
): Promise<AppointmentRow> {
  const current = await lockAppointment(tx, id);
  if (current.status !== "booked")
    throw new AppointmentError("not_booked");
  const time = toColumn(input.time);
  if (current.scheduledOn === input.date && current.scheduledTime === time)
    return current;
  await clinic(tx, current.servicePointId);
  checkWhen(input.date, input.time ?? null, at);

  let moved: AppointmentRow;
  try {
    [moved] = await tx
      .update(appointments)
      .set({ scheduledOn: input.date, scheduledTime: time })
      .where(eq(appointments.id, id))
      .returning();
  }
  catch (err) {
    if (slotTaken(err))
      throw new AppointmentError("already_booked");
    throw err;
  }

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "appointment.moved",
    entityType: "appointment",
    entityId: id,
    summary: `Moved an appointment from ${current.scheduledOn} to ${input.date}`,
    detail: {
      before: { date: current.scheduledOn, time: toClock(current.scheduledTime) },
      after: { date: moved.scheduledOn, time: toClock(moved.scheduledTime) },
    },
  });
  await queueReminder(tx, facilityId, id, moved.scheduledOn, at);
  return moved;
}

export async function cancelAppointment(tx: AppDb, facilityId: string, id: string, reason: string, actor: PatientActor, at = new Date()): Promise<AppointmentRow> {
  const current = await lockAppointment(tx, id);
  if (current.status !== "booked")
    throw new AppointmentError("not_booked");
  const [cancelled] = await tx
    .update(appointments)
    .set({ status: "cancelled", cancelledAt: at, cancelledBy: actor.membershipId, cancelReason: reason })
    .where(eq(appointments.id, id))
    .returning();
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "appointment.cancelled",
    entityType: "appointment",
    entityId: id,
    summary: `Cancelled the appointment for ${current.scheduledOn}`,
    detail: { reason },
  });
  return cancelled;
}

/**
 * Checks a patient in on their appointment's day: opens their outpatient
 * visit, or uses the one already open. The patient goes to triage like any
 * visit (`queueAt` left out), straight to a clinic (`queueAt` names it), or
 * nowhere (`null`). A patient already in a queue stays there, unless a queue
 * was named, which is refused.
 */
export async function checkIn(
  tx: AppDb,
  facilityId: string,
  id: string,
  input: { queueAt?: string | null },
  actor: PatientActor,
  at = new Date(),
): Promise<{ appointment: AppointmentRow; encounterId: string; openedVisit: boolean }> {
  const current = await lockAppointment(tx, id);
  if (current.status !== "booked")
    throw new AppointmentError("not_booked");
  if (current.scheduledOn !== businessDate(at))
    throw new AppointmentError("not_today");

  const [open] = await tx
    .select({ id: encounters.id, kind: encounters.kind, status: encounters.status })
    .from(encounters)
    .where(and(eq(encounters.patientId, current.patientId), eq(encounters.kind, "opd"), eq(encounters.status, "open")))
    .for("update")
    .limit(1);

  let encounterId: string;
  if (!open) {
    encounterId = (await openEncounter(tx, facilityId, { patientId: current.patientId, kind: "opd", queueAt: input.queueAt }, actor, at)).id;
  }
  else {
    encounterId = open.id;
    const target = input.queueAt === undefined ? await defaultTriagePoint(tx) : input.queueAt;
    if (target) {
      if (!await liveEntryOf(tx, open.id))
        await joinLocked(tx, facilityId, open, target, actor, at);
      else if (input.queueAt !== undefined)
        throw new QueueError("already_queued");
    }
  }

  const [appointment] = await tx
    .update(appointments)
    .set({ status: "checked_in", checkedInAt: at, checkedInBy: actor.membershipId, encounterId })
    .where(eq(appointments.id, id))
    .returning();
  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "appointment.checked_in",
    entityType: "appointment",
    entityId: id,
    summary: open ? "Checked in to the visit already open" : "Checked in, opening a visit",
    detail: { encounterId, openedVisit: !open },
  });
  return { appointment, encounterId, openedVisit: !open };
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

export interface ListedAppointment {
  id: string;
  patient: WorklistPatient;
  servicePoint: { id: string; name: string };
  clinician: { membershipId: string; name: string } | null;
  date: string;
  time: string | null;
  status: AppointmentStatus;
  /** Still booked after its day: derived, never stored. */
  missed: boolean;
  bookedAt: Date;
  /** The visit it was checked into. */
  encounterId: string | null;
}

const clinicianMembership = alias(memberships, "clinician_membership");
const clinicianUser = alias(user, "clinician_user");

/** The rows a list shows, newest page logic left to the caller. */
function listQuery(tx: AppDb) {
  return tx
    .select({
      id: appointments.id,
      ...patientColumns,
      servicePointId: servicePoints.id,
      servicePointName: servicePoints.name,
      clinicianId: clinicianMembership.id,
      clinicianName: clinicianUser.name,
      date: appointments.scheduledOn,
      time: appointments.scheduledTime,
      status: appointments.status,
      bookedAt: appointments.bookedAt,
      encounterId: appointments.encounterId,
      total: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(appointments)
    .innerJoin(patients, eq(patients.id, appointments.patientId))
    .leftJoin(patientNumbers, and(eq(patientNumbers.patientId, patients.id), eq(patientNumbers.kind, "outpatient")))
    .innerJoin(servicePoints, eq(servicePoints.id, appointments.servicePointId))
    .leftJoin(clinicianMembership, eq(clinicianMembership.id, appointments.clinicianId))
    .leftJoin(clinicianUser, eq(clinicianUser.id, clinicianMembership.userId));
}

type ListRow = Awaited<ReturnType<ReturnType<typeof listQuery>["execute"]>>[number];

function listed(r: ListRow, today: string): ListedAppointment {
  return {
    id: r.id,
    patient: patientOf(r, today),
    servicePoint: { id: r.servicePointId, name: r.servicePointName },
    clinician: r.clinicianId ? { membershipId: r.clinicianId, name: r.clinicianName ?? "" } : null,
    date: r.date,
    time: toClock(r.time),
    status: r.status,
    missed: r.status === "booked" && r.date < today,
    bookedAt: r.bookedAt,
    encounterId: r.encounterId,
  };
}

/**
 * One day's appointments, at one clinic or with one clinician if asked: by
 * time (those with none last), then as booked. Cancelled ones are left out.
 * Audited, since it names patients and where they are to be seen.
 */
export async function listDay(
  tx: AppDb,
  facilityId: string,
  filter: { date: string; servicePointId?: string; clinicianId?: string; offset?: number },
  actor: PatientActor,
  at = new Date(),
): Promise<{ appointments: ListedAppointment[]; total: number }> {
  const rows = await listQuery(tx)
    .where(and(
      eq(appointments.scheduledOn, filter.date),
      ne(appointments.status, "cancelled"),
      filter.servicePointId ? eq(appointments.servicePointId, filter.servicePointId) : undefined,
      filter.clinicianId ? eq(appointments.clinicianId, filter.clinicianId) : undefined,
    ))
    .orderBy(sql`${appointments.scheduledTime} ASC NULLS LAST`, asc(appointments.bookedAt), asc(appointments.id))
    .limit(DAY_LIST_LIMIT)
    .offset(filter.offset ?? 0);

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "appointment.listed",
    entityType: "appointment",
    summary: `Listed appointments for ${filter.date}`,
    detail: { date: filter.date, servicePointId: filter.servicePointId ?? null, clinicianId: filter.clinicianId ?? null, shown: rows.length },
  });
  const today = businessDate(at);
  return { appointments: rows.map(r => listed(r, today)), total: rows[0]?.total ?? 0 };
}

/** A patient's appointments, latest day first, cancelled ones included. Audited. */
export async function patientAppointments(
  tx: AppDb,
  facilityId: string,
  patientId: string,
  actor: PatientActor,
  offset = 0,
  at = new Date(),
): Promise<{ appointments: ListedAppointment[]; total: number }> {
  const [patient] = await tx.select({ id: patients.id }).from(patients).where(eq(patients.id, patientId)).limit(1);
  if (!patient)
    throw new AppointmentError("patient_not_found");
  const rows = await listQuery(tx)
    .where(eq(appointments.patientId, patientId))
    .orderBy(desc(appointments.scheduledOn), sql`${appointments.scheduledTime} DESC NULLS LAST`, desc(appointments.bookedAt))
    .limit(PATIENT_LIST_LIMIT)
    .offset(offset);

  await recordAudit(tx, {
    facilityId,
    actorId: actor.userId,
    action: "appointment.listed",
    entityType: "patient",
    entityId: patientId,
    summary: "Listed a patient's appointments",
    detail: { shown: rows.length },
  });
  const today = businessDate(at);
  return { appointments: rows.map(r => listed(r, today)), total: rows[0]?.total ?? 0 };
}
