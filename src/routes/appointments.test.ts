import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { StaffMember } from "@/test/hospital";

import app from "@/app";
import db, { pool } from "@/db";
import { appointmentReminders, appointments, auditLog, charges, outbox, queueEntries } from "@/db/schema";
import { drainOutbox } from "@/jobs/outbox-worker";
import { abandonAppointmentReminder, reminderDueAt, sendAppointmentReminder } from "@/lib/appointment-reminders";
import { addDays, businessDate, printedDayAndDate } from "@/lib/dates";
import { sentSms, SmsError } from "@/lib/sms";
import { addMembership, nextIp, resetDb, signedInUser } from "@/test/helpers";
import { call, hospital } from "@/test/hospital";

/** P3 slice 6: appointments, checking in, and the SMS reminder the day before. */

type Roles = Parameters<typeof addMembership>[2];

async function clinic() {
  const h = await hospital();
  const person = async (roles: Roles): Promise<StaffMember> => {
    const user = await signedInUser();
    const membership = await addMembership(user.id, h.facility.id, roles);
    return { ...user, actor: { userId: user.id, membershipId: membership.id } };
  };
  const clerk = await person(["records_clerk"]);
  const doctor = await person(["doctor"]);
  const wardNurse = await person(["ward_nurse"]);
  const point = async (name: string, kind: "triage" | "consultation") =>
    (await (await call("POST", "/service-points", h.facility.id, h.admin, { name, kind })).json()).id as string;
  const triage = await point("Triage", "triage");
  const gopd = await point("General OPD", "consultation");

  const patient = async (options: { givenName?: string; phone?: string } = {}) =>
    (await (await call("POST", "/patients", h.facility.id, clerk, {
      givenName: options.givenName ?? "Amina",
      familyName: "Wafula",
      sex: "female",
      dateOfBirth: "1990-05-01",
      ...(options.phone ? { phone: options.phone } : { noPhoneReason: "no_phone" }),
      noIdReason: "not_carried",
      confirmNotDuplicate: true,
    })).json()).id as string;

  return { ...h, person, clerk, doctor, wardNurse, point, triage, gopd, patient };
}

type Clinic = Awaited<ReturnType<typeof clinic>>;

const TODAY = () => businessDate();
const IN = (days: number) => addDays(TODAY(), days);

function book(c: Clinic, body: Record<string, unknown>, who: StaffMember = c.clerk) {
  return call("POST", "/appointments", c.facility.id, who, { servicePointId: c.gopd, date: IN(2), ...body });
}
async function booked(c: Clinic, body: Record<string, unknown>, who?: StaffMember) {
  const res = await book(c, body, who);
  expect(res.status).toBe(201);
  return res.json();
}
const post = (c: Clinic, path: string, body: unknown, who: StaffMember = c.clerk) => call("POST", path, c.facility.id, who, body);
const code = async (res: Response) => [res.status, (await res.json()).code];

async function audits(c: Clinic, action: string) {
  return db.select().from(auditLog).where(and(eq(auditLog.facilityId, c.facility.id), eq(auditLog.action, action as never)));
}
async function reminderOf(appointmentId: string, date: string) {
  const [row] = await db.select().from(appointmentReminders).where(and(eq(appointmentReminders.appointmentId, appointmentId), eq(appointmentReminders.remindsOf, date)));
  return row;
}
function remind(c: Clinic, reminderId: string, send?: Parameters<typeof sendAppointmentReminder>[1]) {
  return sendAppointmentReminder({ facilityId: c.facility.id, subjectId: reminderId }, send);
}

beforeEach(async () => {
  await resetDb();
});

describe("booking", () => {
  it("books a clinic for a day, with a time and a clinician, and holds the reminder back to 17:00 the day before", async () => {
    const c = await clinic();
    const patientId = await c.patient({ phone: "0712 345 678" });

    const appointment = await booked(c, { patientId, clinicianId: c.doctor.actor.membershipId, time: "09:30", smsReminders: true });

    expect(appointment).toMatchObject({
      patientId,
      servicePointId: c.gopd,
      clinicianId: c.doctor.actor.membershipId,
      date: IN(2),
      time: "09:30",
      status: "booked",
      missed: false,
      bookedDuring: null,
      encounterId: null,
    });
    const reminder = await reminderOf(appointment.id, IN(2));
    expect(reminder).toMatchObject({ status: "scheduled", toPhone: null, body: null });
    expect(reminder.dueAt.toISOString()).toBe(new Date(`${IN(1)}T17:00:00+03:00`).toISOString());
    const [job] = await db.select().from(outbox).where(eq(outbox.subjectId, reminder.id));
    expect(job).toMatchObject({ operation: "appointment.remind", status: "pending" });
    expect(job.availableAt.getTime()).toBe(reminder.dueAt.getTime());
    // The sweep leaves it until then.
    expect(await drainOutbox()).toMatchObject({ done: 0, skipped: 0 });

    expect((await audits(c, "appointment.booked"))[0].detail).toEqual({
      patientId,
      servicePointId: c.gopd,
      clinicianId: c.doctor.actor.membershipId,
      date: IN(2),
      time: "09:30",
    });
    // The answer was recorded on the patient, with who and when.
    expect((await audits(c, "patient.sms_reminders_set"))[0].detail).toEqual({ from: null, to: true });
    const record = await (await call("GET", `/patients/${patientId}`, c.facility.id, c.clerk)).json();
    expect(record.smsReminders).toBe(true);
  });

  it("asks a patient with a phone about reminders the first time, and records a follow-up's visit", async () => {
    const c = await clinic();
    const withPhone = await c.patient({ phone: "0712345678" });

    expect(await code(await book(c, { patientId: withPhone }))).toEqual([409, "sms_answer_needed"]);
    await booked(c, { patientId: withPhone, smsReminders: false });
    // Asked once: the next booking needs no answer. No yes, so no reminder is scheduled to send.
    const second = await booked(c, { patientId: withPhone, date: IN(3) });
    expect((await remind(c, (await reminderOf(second.id, IN(3))).id))).toBe("skipped");
    expect((await reminderOf(second.id, IN(3))).outcomeNote).toBe("The patient has not agreed to SMS reminders");

    // No phone, nothing to ask. Booked during an open visit, that visit is recorded.
    const noPhone = await c.patient({ givenName: "Baraka" });
    const visit = await (await post(c, "/encounters", { patientId: noPhone, kind: "opd", queueAt: null })).json();
    expect((await booked(c, { patientId: noPhone })).bookedDuring).toBe(visit.id);
  });

  it("refuses what cannot be kept: triage, a retired clinic, a non-clinician, the past, beyond a year, or twice", async () => {
    const c = await clinic();
    const patientId = await c.patient();
    const retired = await c.point("Eye clinic", "consultation");
    await call("PATCH", `/service-points/${retired}`, c.facility.id, c.admin, { isActive: false });

    expect(await code(await book(c, { patientId, servicePointId: c.triage }))).toEqual([409, "not_a_clinic"]);
    expect(await code(await book(c, { patientId, servicePointId: retired }))).toEqual([409, "service_point_retired"]);
    expect(await code(await book(c, { patientId, clinicianId: c.cashier.actor.membershipId }))).toEqual([409, "not_a_clinician"]);
    expect(await code(await book(c, { patientId, date: IN(-1) }))).toEqual([409, "in_the_past"]);
    expect(await code(await book(c, { patientId, date: TODAY(), time: "00:00" }))).toEqual([409, "in_the_past"]);
    expect(await code(await book(c, { patientId, date: IN(366) }))).toEqual([409, "too_far_ahead"]);
    await booked(c, { patientId });
    expect(await code(await book(c, { patientId }))).toEqual([409, "already_booked"]);

    const unknown = await book(c, { patientId, servicePointId: "00000000-0000-4000-8000-000000000000" });
    expect([unknown.status, (await unknown.json()).error.issues[0].path]).toEqual([422, ["servicePointId"]]);
    expect((await book(c, { patientId: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
    expect((await book(c, { patientId, time: "9:30" })).status).toBe(422);
    expect((await book(c, { patientId, reason: "Review" })).status).toBe(422);
    expect((await book(c, { patientId }, c.cashier)).status).toBe(403);
  });

  it("keeps a clinic in use while patients are booked there from today on", async () => {
    const c = await clinic();
    const appointment = await booked(c, { patientId: await c.patient() });
    const retire = () => call("PATCH", `/service-points/${c.gopd}`, c.facility.id, c.admin, { isActive: false });

    expect(await code(await retire())).toEqual([409, "has_appointments"]);
    await post(c, `/appointments/${appointment.id}/cancel`, { reason: "Patient travelling" });
    expect((await retire()).status).toBe(200);
  });
});

describe("moving and cancelling", () => {
  it("moves a booked appointment, audited, and its reminder follows it", async () => {
    const c = await clinic();
    const patientId = await c.patient({ phone: "0712345678" });
    const appointment = await booked(c, { patientId, time: "09:30", smsReminders: true });

    const res = await post(c, `/appointments/${appointment.id}/move`, { date: IN(3), time: "14:00" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ date: IN(3), time: "14:00", status: "booked" });
    expect((await audits(c, "appointment.moved"))[0].detail).toEqual({
      before: { date: IN(2), time: "09:30" },
      after: { date: IN(3), time: "14:00" },
    });
    // The old day's reminder finds the appointment elsewhere; the new day's sends.
    const old = await reminderOf(appointment.id, IN(2));
    expect(await remind(c, old.id)).toBe("skipped");
    expect((await reminderOf(appointment.id, IN(2))).outcomeNote).toBe("The appointment was moved to another day");
    expect(await remind(c, (await reminderOf(appointment.id, IN(3))).id)).toBe("done");
    expect(sentSms.at(-1)?.body).toContain("at 2:00 pm");

    // The same day and time again changes nothing.
    await post(c, `/appointments/${appointment.id}/move`, { date: IN(3), time: "14:00" });
    expect(await audits(c, "appointment.moved")).toHaveLength(1);
    expect(await code(await post(c, `/appointments/${appointment.id}/move`, { date: IN(-1) }))).toEqual([409, "in_the_past"]);
  });

  it("cancels with a reason, after which it is neither moved, checked in nor reminded of", async () => {
    const c = await clinic();
    const appointment = await booked(c, { patientId: await c.patient({ phone: "0712345678" }), date: TODAY(), smsReminders: true });
    const later = await booked(c, { patientId: await c.patient({ givenName: "Baraka", phone: "0722345678" }), smsReminders: true });

    expect((await post(c, `/appointments/${appointment.id}/cancel`, { reason: " " })).status).toBe(422);
    const res = await post(c, `/appointments/${appointment.id}/cancel`, { reason: "Patient travelling" });
    expect(await res.json()).toMatchObject({ status: "cancelled", cancelReason: "Patient travelling" });

    expect(await code(await post(c, `/appointments/${appointment.id}/cancel`, { reason: "Again" }))).toEqual([409, "not_booked"]);
    expect(await code(await post(c, `/appointments/${appointment.id}/move`, { date: IN(4) }))).toEqual([409, "not_booked"]);
    expect(await code(await post(c, `/appointments/${appointment.id}/check-in`, {}))).toEqual([409, "not_booked"]);

    await post(c, `/appointments/${later.id}/cancel`, { reason: "Recovered" });
    expect(await remind(c, (await reminderOf(later.id, IN(2))).id)).toBe("skipped");
    expect((await reminderOf(later.id, IN(2))).outcomeNote).toBe("The appointment is no longer booked");
  });
});

describe("checking in", () => {
  it("opens the visit on the day and sends the patient to triage, like any visit", async () => {
    const c = await clinic();
    const patientId = await c.patient();
    const today = await booked(c, { patientId, date: TODAY() });
    const later = await booked(c, { patientId: await c.patient({ givenName: "Baraka" }) });

    expect(await code(await post(c, `/appointments/${later.id}/check-in`, {}))).toEqual([409, "not_today"]);
    const res = await post(c, `/appointments/${today.id}/check-in`, {});

    expect(res.status).toBe(200);
    const checked = await res.json();
    expect(checked).toMatchObject({ openedVisit: true, appointment: { status: "checked_in", encounterId: checked.encounterId } });
    const [entry] = await db.select().from(queueEntries).where(eq(queueEntries.encounterId, checked.encounterId));
    expect(entry).toMatchObject({ servicePointId: c.triage, status: "waiting" });
    expect((await audits(c, "appointment.checked_in"))[0].detail).toEqual({ encounterId: checked.encounterId, openedVisit: true });
    // Checking in opens a visit, which ward nurses do not.
    const another = await booked(c, { patientId: await c.patient({ givenName: "Chebet" }), date: TODAY() }, c.wardNurse);
    expect((await post(c, `/appointments/${another.id}/check-in`, {}, c.wardNurse)).status).toBe(403);
  });

  it("sends a patient straight to the clinic named, charging its fee", async () => {
    const c = await clinic();
    await call("PATCH", `/service-points/${c.gopd}`, c.facility.id, c.admin, { consultationItemId: c.items.consultation });
    const appointment = await booked(c, { patientId: await c.patient(), date: TODAY() });

    const checked = await (await post(c, `/appointments/${appointment.id}/check-in`, { queueAt: c.gopd })).json();

    const [fee] = await db.select().from(charges).where(eq(charges.encounterId, checked.encounterId));
    expect(fee).toMatchObject({ billableItemId: c.items.consultation, amountCents: 50_000 });
  });

  it("uses the visit already open, leaving a patient in the queue they are in", async () => {
    const c = await clinic();
    const patientId = await c.patient();
    const visit = await (await post(c, "/encounters", { patientId, kind: "opd" })).json();
    const first = await booked(c, { patientId, date: TODAY() });
    const second = await booked(c, { patientId, date: TODAY(), servicePointId: await c.point("MCH", "consultation") });

    // Named a queue while in one: refused, and nothing changes.
    expect(await code(await post(c, `/appointments/${first.id}/check-in`, { queueAt: c.gopd }))).toEqual([409, "already_queued"]);
    const checked = await (await post(c, `/appointments/${first.id}/check-in`, {})).json();
    expect(checked).toMatchObject({ openedVisit: false, encounterId: visit.id });
    const entries = await db.select().from(queueEntries).where(eq(queueEntries.encounterId, visit.id));
    expect(entries.map(e => e.servicePointId)).toEqual([c.triage]);
    // The second clinic's appointment joins the same visit.
    expect((await (await post(c, `/appointments/${second.id}/check-in`, { queueAt: null })).json()).encounterId).toBe(visit.id);
  });
});

describe("lists", () => {
  it("lists a day's appointments by time, with how many, and audits it; one left booked after its day was missed", async () => {
    const c = await clinic();
    const late = await booked(c, { patientId: await c.patient({ givenName: "Late" }), time: "14:00" });
    const early = await booked(c, { patientId: await c.patient({ givenName: "Early" }), time: "09:00", clinicianId: c.doctor.actor.membershipId });
    const anyTime = await booked(c, { patientId: await c.patient({ givenName: "Any" }) });
    const gone = await booked(c, { patientId: await c.patient({ givenName: "Gone" }) });
    await post(c, `/appointments/${gone.id}/cancel`, { reason: "Recovered" });

    const day = await (await call("GET", `/appointments?date=${IN(2)}`, c.facility.id, c.clerk)).json();

    expect(day.total).toBe(3);
    expect(day.appointments.map((a: { id: string }) => a.id)).toEqual([early.id, late.id, anyTime.id]);
    expect(day.appointments[0]).toMatchObject({
      patient: { name: "Early Wafula", sex: "female" },
      servicePoint: { id: c.gopd, name: "General OPD" },
      clinician: { membershipId: c.doctor.actor.membershipId },
      time: "09:00",
      missed: false,
    });
    const doctors = await (await call("GET", `/appointments?date=${IN(2)}&clinicianId=${c.doctor.actor.membershipId}`, c.facility.id, c.doctor)).json();
    expect(doctors.appointments.map((a: { id: string }) => a.id)).toEqual([early.id]);
    expect((await audits(c, "appointment.listed"))[0].detail).toMatchObject({ date: IN(2), shown: 3 });
    expect((await call("GET", "/appointments", c.facility.id, c.cashier)).status).toBe(403);

    // Booked for yesterday (a record brought in) and never checked in.
    const patientId = await c.patient({ givenName: "Missed" });
    await db.insert(appointments).values({ facilityId: c.facility.id, patientId, servicePointId: c.gopd, scheduledOn: IN(-1), bookedAt: new Date(Date.now() - 172_800_000), bookedBy: c.clerk.actor.membershipId });
    const yesterday = await (await call("GET", `/appointments?date=${IN(-1)}`, c.facility.id, c.clerk)).json();
    expect(yesterday.appointments[0]).toMatchObject({ status: "booked", missed: true });
  });

  it("lists a patient's appointments latest first, cancelled ones too, and records their answer to reminders", async () => {
    const c = await clinic();
    const patientId = await c.patient({ phone: "0712345678" });
    const first = await booked(c, { patientId, smsReminders: true });
    const second = await booked(c, { patientId, date: IN(5) });
    await post(c, `/appointments/${first.id}/cancel`, { reason: "Moved away" });

    const listed = await (await call("GET", `/patients/${patientId}/appointments`, c.facility.id, c.clerk)).json();
    expect(listed.appointments.map((a: { id: string; status: string }) => [a.id, a.status])).toEqual([[second.id, "booked"], [first.id, "cancelled"]]);

    const answer = (wanted: boolean) => call("PUT", `/patients/${patientId}/sms-reminders`, c.facility.id, c.clerk, { wanted });
    expect(await (await answer(false)).json()).toEqual({ smsReminders: false });
    await answer(false);
    expect((await audits(c, "patient.sms_reminders_set")).map(a => a.detail)).toEqual([{ from: null, to: true }, { from: true, to: false }]);
    expect((await call("PUT", `/patients/${patientId}/sms-reminders`, c.facility.id, c.cashier, { wanted: true })).status).toBe(403);
  });
});

describe("the reminder", () => {
  it("names the patient, the facility, the day and time and the number to call, never the clinic", async () => {
    const c = await clinic();
    expect((await call("PATCH", "/facility", c.facility.id, c.clerk, { phone: "0722 000 111" })).status).toBe(403);
    const set = await call("PATCH", "/facility", c.facility.id, c.admin, { phone: "0722 000 111" });
    expect(await set.json()).toMatchObject({ phone: "+254722000111", smsSenderId: null });
    expect((await audits(c, "facility.updated"))[0].detail).toEqual({ phone: { from: null, to: "+254722000111" } });
    const appointment = await booked(c, { patientId: await c.patient({ phone: "0712345678" }), time: "09:30", smsReminders: true });
    const reminder = await reminderOf(appointment.id, IN(2));
    const sent = sentSms.length;

    expect(await remind(c, reminder.id)).toBe("done");

    const body = `Hello Amina, this is a reminder of your appointment at ${c.facility.name} on ${printedDayAndDate(IN(2))} at 9:30 am. To change it, call 0722 000 111.`;
    expect(sentSms.slice(sent)).toEqual([{ to: "+254712345678", body }]);
    expect(body).not.toContain("General OPD");
    expect(await reminderOf(appointment.id, IN(2))).toMatchObject({ status: "sent", toPhone: "+254712345678", body, costCents: 80, outcomeNote: null });
    // Sent once: delivered again, it is skipped.
    expect(await remind(c, reminder.id)).toBe("skipped");
    expect(sentSms).toHaveLength(sent + 1);
  });

  it("goes out from the outbox once due, under the facility's own sender", async () => {
    const c = await clinic();
    const superadmin = await signedInUser({ role: "superadmin" });
    const res = await app.request(`/superadmin/facilities/${c.facility.id}/sms-sender`, {
      method: "PUT",
      headers: { ...superadmin.headers, "content-type": "application/json", "x-forwarded-for": nextIp() },
      body: JSON.stringify({ senderId: "MERCYHOSP" }),
    });
    expect(await res.json()).toEqual({ id: c.facility.id, smsSenderId: "MERCYHOSP" });
    const appointment = await booked(c, { patientId: await c.patient({ phone: "0712345678" }), smsReminders: true });
    const reminder = await reminderOf(appointment.id, IN(2));
    await db.update(outbox).set({ availableAt: new Date() }).where(eq(outbox.subjectId, reminder.id));

    expect(await drainOutbox()).toMatchObject({ done: 1 });

    expect(sentSms.at(-1)).toMatchObject({ to: "+254712345678", from: "MERCYHOSP" });
    expect((await reminderOf(appointment.id, IN(2))).status).toBe("sent");
  });

  it("is retried as first written when Africa's Talking cannot be reached, and failed once the outbox gives up", async () => {
    const c = await clinic();
    await call("PATCH", "/facility", c.facility.id, c.admin, { phone: "0722000111" });
    const first = await booked(c, { patientId: await c.patient({ phone: "0712345678" }), smsReminders: true });
    const reminder = await reminderOf(first.id, IN(2));
    const down = async () => {
      throw new SmsError("Could not reach Africa's Talking");
    };

    await expect(remind(c, reminder.id, down)).rejects.toThrow(SmsError);
    const sending = await reminderOf(first.id, IN(2));
    expect(sending.status).toBe("sending");
    // The retry sends what was first written, whatever has changed since.
    await call("PATCH", "/facility", c.facility.id, c.admin, { phone: null });
    expect(await remind(c, reminder.id)).toBe("done");
    expect(sentSms.at(-1)?.body).toBe(sending.body);

    const second = await booked(c, { patientId: await c.patient({ givenName: "Baraka", phone: "0722345678" }), smsReminders: true });
    const another = await reminderOf(second.id, IN(2));
    await expect(remind(c, another.id, down)).rejects.toThrow(SmsError);
    await abandonAppointmentReminder({ facilityId: c.facility.id, subjectId: another.id });
    expect(await reminderOf(second.id, IN(2))).toMatchObject({ status: "failed", outcomeNote: "Africa's Talking could not be reached after several tries" });
  });

  it("records a refusal for the number as rejected, with Africa's Talking's reason", async () => {
    const c = await clinic();
    const appointment = await booked(c, { patientId: await c.patient({ phone: "0712345678" }), smsReminders: true });
    const reminder = await reminderOf(appointment.id, IN(2));

    expect(await remind(c, reminder.id, async () => ({ accepted: false, providerMessageId: null, costCents: null, reason: "InvalidPhoneNumber" }))).toBe("done");

    expect(await reminderOf(appointment.id, IN(2))).toMatchObject({ status: "rejected", outcomeNote: "InvalidPhoneNumber" });
  });

  it("is not scheduled for a booking made after its time", async () => {
    const c = await clinic();
    const appointment = await booked(c, { patientId: await c.patient({ phone: "0712345678" }), date: TODAY(), smsReminders: true });

    expect(reminderDueAt(TODAY()).getTime()).toBeLessThan(Date.now());
    expect(await reminderOf(appointment.id, TODAY())).toBeUndefined();
  });
});

describe("the database's appointment guards", () => {
  it("hold an appointment's lifecycle and its reminder's for every role", async () => {
    const c = await clinic();
    const patientId = await c.patient({ phone: "0712345678" });
    const appointment = await booked(c, { patientId, date: TODAY(), smsReminders: true });
    const later = await booked(c, { patientId, smsReminders: true });
    const reminder = await reminderOf(later.id, IN(2));
    const state = (q: Promise<unknown>) => q.then(() => "ok", (e: { constraint?: string; code?: string }) => e.constraint ?? e.code);

    expect(await state(pool.query("DELETE FROM appointments WHERE id = $1", [appointment.id]))).toBe("23001");
    expect(await state(pool.query("UPDATE appointments SET clinician_id = $2 WHERE id = $1", [appointment.id, c.doctor.actor.membershipId]))).toBe("23001");
    expect(await state(pool.query(
      "INSERT INTO appointments (facility_id, patient_id, service_point_id, scheduled_on, booked_at, booked_by) VALUES ($1, $2, $3, $4, now(), $5)",
      [c.facility.id, patientId, c.triage, IN(4), c.clerk.actor.membershipId],
    ))).toBe("23514");
    expect(await state(pool.query("UPDATE appointments SET status = 'cancelled', cancelled_at = now(), cancelled_by = booked_by WHERE id = $1", [appointment.id]))).toBe("appointments_lifecycle");

    await post(c, `/appointments/${appointment.id}/check-in`, {});
    expect(await state(pool.query("UPDATE appointments SET scheduled_on = $2 WHERE id = $1", [appointment.id, IN(3)]))).toBe("23001");

    expect(await state(pool.query("UPDATE appointment_reminders SET reminds_of = $2 WHERE id = $1", [reminder.id, IN(3)]))).toBe("23001");
    expect(await state(pool.query("UPDATE appointment_reminders SET status = 'sent', completed_at = now() WHERE id = $1", [reminder.id]))).toBe("23001");
    expect(await remind(c, reminder.id)).toBe("done");
    expect(await state(pool.query("UPDATE appointment_reminders SET status = 'skipped', outcome_note = 'x' WHERE id = $1", [reminder.id]))).toBe("23001");
    expect(await state(pool.query("DELETE FROM appointment_reminders WHERE id = $1", [reminder.id]))).toBe("23001");
  });
});
