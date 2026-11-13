import { and, eq, inArray } from "drizzle-orm";

import type { AppDb } from "@/db";
import type { SmsResult } from "@/lib/sms";

import { appointmentReminders, appointments, facilities, patients } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import env from "@/env";
import { sendSms, smsDeliverable } from "@/lib/sms";

import { addDays, businessDate, printedDayAndDate, startOfBusinessDay } from "./dates";
import { enqueue } from "./outbox";

/**
 * The SMS reminding a patient of an appointment (ROADMAP.md P3, decided
 * 2026-11-13): one, at 17:00 Kenyan time the day before, only to a patient
 * who said yes, naming the facility, the day and time, and the number to call,
 * never the clinic, the clinician or why.
 *
 * Booking or moving an appointment writes a `scheduled` row for its day and an
 * outbox job held back to the row's `due_at` (rule 18). The outbox sweep
 * delivers it; a Cloud Task cannot be scheduled more than 30 days ahead, and
 * clinics book months out. The job re-reads the appointment as it runs and is
 * skipped if it no longer fits: moved to another day, checked in, cancelled,
 * or the patient's answer changed.
 */

/** The hour, Kenyan time, on the day before. */
export const REMINDER_HOUR = 17;

/** A Kenyan mobile number: what a reminder may go to (the CHECK on `to_phone`). */
const KENYAN_MOBILE = /^\+254[17]\d{8}$/;

type ReminderRow = typeof appointmentReminders.$inferSelect;

/** When the reminder for an appointment on `date` goes: 17:00 the day before. */
export function reminderDueAt(date: string): Date {
  return new Date(startOfBusinessDay(addDays(date, -1)).getTime() + REMINDER_HOUR * 3_600_000);
}

/**
 * Schedules the reminder for an appointment's day, in the transaction that
 * booked or moved it. Nothing when that time has passed: a patient booked
 * after it was just told. A day already scheduled (moved away and back) keeps
 * its one row and job.
 */
export async function queueReminder(tx: AppDb, facilityId: string, appointmentId: string, date: string, at: Date): Promise<void> {
  const dueAt = reminderDueAt(date);
  if (dueAt <= at)
    return;
  const [row] = await tx
    .insert(appointmentReminders)
    .values({ facilityId, appointmentId, remindsOf: date, dueAt })
    .onConflictDoNothing({ target: [appointmentReminders.appointmentId, appointmentReminders.remindsOf] })
    .returning({ id: appointmentReminders.id });
  if (row)
    await enqueue(tx, { facilityId, operation: "appointment.remind", subjectId: row.id, availableAt: dueAt });
}

/** `09:30:00` as said in a message: `9:30 am`. */
function clockTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/** `+254712345678` as Kenyans dial it: `0712 345 678`. Any other number as stored. */
function dialledNumber(phone: string): string {
  const local = /^\+254(\d{3})(\d{3})(\d{3})$/.exec(phone);
  return local ? `0${local[1]} ${local[2]} ${local[3]}` : phone;
}

/**
 * What the patient reads. Their given name, the facility, the day and time,
 * and the number to call: never the clinic, the clinician or the reason,
 * since phones are shared and a clinic's name can disclose a diagnosis.
 */
export function reminderText(r: { givenName: string; facilityName: string; facilityPhone: string | null; date: string; time: string | null }): string {
  const when = `${printedDayAndDate(r.date)}${r.time ? ` at ${clockTime(r.time)}` : ""}`;
  const call = r.facilityPhone ? ` To change it, call ${dialledNumber(r.facilityPhone)}.` : "";
  return `Hello ${r.givenName}, this is a reminder of your appointment at ${r.facilityName} on ${when}.${call}`;
}

interface Due {
  appointmentStatus: string;
  scheduledOn: string;
  scheduledTime: string | null;
  givenName: string;
  phone: string | null;
  smsReminders: boolean | null;
  facilityName: string;
  facilityPhone: string | null;
  facilityStatus: string;
  senderId: string | null;
}

/** Why the reminder is not to be sent now, or null if it is. */
function whyNot(reminder: ReminderRow, due: Due, now: Date): string | null {
  if (!smsDeliverable)
    return "SMS is not configured";
  if (due.facilityStatus !== "active")
    return "The facility is suspended";
  if (due.appointmentStatus !== "booked")
    return "The appointment is no longer booked";
  if (due.scheduledOn !== reminder.remindsOf)
    return "The appointment was moved to another day";
  if (due.smsReminders !== true)
    return "The patient has not agreed to SMS reminders";
  if (!due.phone || !KENYAN_MOBILE.test(due.phone))
    return "No Kenyan mobile number on file";
  if (businessDate(now) >= reminder.remindsOf)
    return "The appointment's day came before it could be sent";
  return null;
}

async function skip(tx: AppDb, id: string, note: string, at: Date): Promise<void> {
  await tx
    .update(appointmentReminders)
    .set({ status: "skipped", completedAt: at, outcomeNote: note })
    .where(eq(appointmentReminders.id, id));
}

interface Message {
  to: string;
  body: string;
  from?: string;
}

/**
 * Locks the reminder and decides, from what stands now, whether it goes. One
 * that goes is marked sending with what it says now. A retry composes it
 * again, so it never goes to a number the patient has since replaced, nor
 * gives a time since moved; the row keeps what the last attempt sent. One
 * that does not go is skipped with the reason.
 */
async function startSending(tx: AppDb, reminderId: string, now: Date): Promise<Message | null> {
  const [reminder] = await tx.select().from(appointmentReminders).where(eq(appointmentReminders.id, reminderId)).for("update").limit(1);
  if (!reminder || (reminder.status !== "scheduled" && reminder.status !== "sending"))
    return null;

  const [due] = await tx
    .select({
      appointmentStatus: appointments.status,
      scheduledOn: appointments.scheduledOn,
      scheduledTime: appointments.scheduledTime,
      givenName: patients.givenName,
      phone: patients.phone,
      smsReminders: patients.smsReminders,
      facilityName: facilities.name,
      facilityPhone: facilities.phone,
      facilityStatus: facilities.status,
      senderId: facilities.smsSenderId,
    })
    .from(appointments)
    .innerJoin(patients, eq(patients.id, appointments.patientId))
    .innerJoin(facilities, eq(facilities.id, appointments.facilityId))
    .where(eq(appointments.id, reminder.appointmentId))
    .limit(1);

  const reason = whyNot(reminder, due, now);
  if (reason) {
    await skip(tx, reminder.id, reason, now);
    return null;
  }

  const from = due.senderId ?? env.AT_SENDER_ID;
  const body = reminderText({ ...due, date: due.scheduledOn, time: due.scheduledTime });
  await tx
    .update(appointmentReminders)
    .set({ status: "sending", toPhone: due.phone, body, sendingAt: now })
    .where(eq(appointmentReminders.id, reminder.id));
  return { to: due.phone!, body, ...(from ? { from } : {}) };
}

async function recordResult(tx: AppDb, reminderId: string, result: SmsResult, at: Date): Promise<void> {
  await tx
    .update(appointmentReminders)
    .set({
      status: result.accepted ? "sent" : "rejected",
      completedAt: at,
      providerMessageId: result.providerMessageId,
      costCents: result.costCents,
      outcomeNote: result.accepted ? null : (result.reason?.trim() || "Refused"),
    })
    .where(eq(appointmentReminders.id, reminderId));
}

/**
 * The outbox handler for `appointment.remind`, whose subject is the reminder.
 * A send Africa's Talking refuses for this number is recorded as rejected;
 * one that could not reach it throws, so the outbox retries, and its last
 * failure is recorded by `abandonAppointmentReminder`. `send` is a parameter
 * so a test can make the call fail.
 */
export async function sendAppointmentReminder(
  job: { facilityId: string; subjectId: string },
  send: (message: Message) => Promise<SmsResult> = sendSms,
): Promise<"done" | "skipped"> {
  const message = await runAsFacility(job.facilityId, tx => startSending(tx, job.subjectId, new Date()));
  if (!message)
    return "skipped";
  const result = await send(message);
  await runAsFacility(job.facilityId, tx => recordResult(tx, job.subjectId, result, new Date()));
  return "done";
}

/** The outbox gave up on a reminder: it is marked failed rather than left sending for ever. */
export async function abandonAppointmentReminder(job: { facilityId: string; subjectId: string }): Promise<void> {
  await runAsFacility(job.facilityId, async (tx) => {
    const [reminder] = await tx
      .select({ id: appointmentReminders.id })
      .from(appointmentReminders)
      .where(eq(appointmentReminders.id, job.subjectId))
      .for("update")
      .limit(1);
    if (!reminder)
      return;
    await tx
      .update(appointmentReminders)
      .set({ status: "failed", completedAt: new Date(), outcomeNote: "Africa's Talking could not be reached after several tries" })
      .where(and(eq(appointmentReminders.id, reminder.id), inArray(appointmentReminders.status, ["scheduled", "sending"])));
  });
}
