import type { z } from "@hono/zod-openapi";
import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { appointments } from "@/db/schema";
import type { ListedAppointment } from "@/lib/appointments";
import type { PatientActor } from "@/lib/patients";
import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import * as booking from "@/lib/appointments";
import { businessDate } from "@/lib/dates";
import { EncounterError } from "@/lib/encounters";
import { QueueError } from "@/lib/queues";
import { queueRefusal } from "@/routes/queues/queues.handlers";

import type {
  AppointmentSchema,
  BookAppointmentRoute,
  CancelAppointmentRoute,
  CheckInRoute,
  ListDayRoute,
  MoveAppointmentRoute,
  PatientAppointmentsRoute,
  SetSmsRemindersRoute,
} from "./appointments.routes";

const iso = (d: Date | null) => d?.toISOString() ?? null;

function actorOf(c: Context<TenantBindings>): PatientActor {
  return { userId: c.var.user!.id, membershipId: c.var.membership.id };
}

function appointmentJson(a: typeof appointments.$inferSelect): z.infer<typeof AppointmentSchema> {
  return {
    id: a.id,
    patientId: a.patientId,
    servicePointId: a.servicePointId,
    clinicianId: a.clinicianId,
    date: a.scheduledOn,
    time: booking.toClock(a.scheduledTime),
    status: a.status,
    missed: a.status === "booked" && a.scheduledOn < businessDate(),
    bookedAt: a.bookedAt.toISOString(),
    bookedDuring: a.bookedDuring,
    checkedInAt: iso(a.checkedInAt),
    encounterId: a.encounterId,
    cancelledAt: iso(a.cancelledAt),
    cancelReason: a.cancelReason,
  };
}

function listedJson(a: ListedAppointment) {
  return { ...a, bookedAt: a.bookedAt.toISOString() };
}

/** A body field the request named that does not exist, as a validation issue on that field. */
function noSuch(c: Context, path: string, message: string) {
  return c.json({
    success: false as const,
    error: { name: "ValidationError", issues: [{ code: "custom" as const, path: [path], message }] },
  }, HttpStatusCodes.UNPROCESSABLE_ENTITY);
}

/** The refusals booking and checking in can meet, or null to let the error through. */
function refusal(c: Context<TenantBindings>, err: unknown): Response | null {
  if (err instanceof booking.AppointmentError) {
    if (err.code === "service_point_not_found")
      return noSuch(c, "servicePointId", "No such clinic");
    if (booking.APPOINTMENT_NOT_FOUND.has(err.code))
      return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
    return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
  }
  // Checking in names a service point only in its body's `queueAt`.
  if (err instanceof QueueError && err.code === "service_point_not_found")
    return noSuch(c, "queueAt", "No such service point");
  const queued = queueRefusal(c, err);
  if (queued)
    return queued;
  if (err instanceof EncounterError)
    return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
  return null;
}

async function answer<T>(c: Context<TenantBindings>, act: () => Promise<T>, json: (result: T) => object, status: 200 | 201 = HttpStatusCodes.OK) {
  try {
    return c.json(json(await act()), status);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused;
    throw err;
  }
}

export const bookAppointment: TenantRouteHandler<BookAppointmentRoute> = async (c) => {
  const body = c.req.valid("json");
  return answer(c, () => booking.bookAppointment(c.var.db, c.var.facility.id, body, actorOf(c)), appointmentJson, HttpStatusCodes.CREATED) as never;
};

export const listDay: TenantRouteHandler<ListDayRoute> = async (c) => {
  const { date, ...filter } = c.req.valid("query");
  const found = await booking.listDay(c.var.db, c.var.facility.id, { ...filter, date: date ?? businessDate() }, actorOf(c));
  return c.json({ appointments: found.appointments.map(listedJson), total: found.total }, HttpStatusCodes.OK);
};

export const moveAppointment: TenantRouteHandler<MoveAppointmentRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  return answer(c, () => booking.moveAppointment(c.var.db, c.var.facility.id, id, body, actorOf(c)), appointmentJson) as never;
};

export const cancelAppointment: TenantRouteHandler<CancelAppointmentRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { reason } = c.req.valid("json");
  return answer(c, () => booking.cancelAppointment(c.var.db, c.var.facility.id, id, reason, actorOf(c)), appointmentJson) as never;
};

export const checkIn: TenantRouteHandler<CheckInRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  return answer(
    c,
    () => booking.checkIn(c.var.db, c.var.facility.id, id, body, actorOf(c)),
    r => ({ appointment: appointmentJson(r.appointment), encounterId: r.encounterId, openedVisit: r.openedVisit }),
  ) as never;
};

export const patientAppointments: TenantRouteHandler<PatientAppointmentsRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { offset } = c.req.valid("query");
  return answer(
    c,
    () => booking.patientAppointments(c.var.db, c.var.facility.id, id, actorOf(c), offset),
    found => ({ appointments: found.appointments.map(listedJson), total: found.total }),
  ) as never;
};

export const setSmsReminders: TenantRouteHandler<SetSmsRemindersRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { wanted } = c.req.valid("json");
  return answer(c, () => booking.setSmsReminders(c.var.db, c.var.facility.id, id, wanted, actorOf(c)), smsReminders => ({ smsReminders })) as never;
};
