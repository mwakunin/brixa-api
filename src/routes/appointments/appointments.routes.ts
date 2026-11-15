import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { requireMembershipRole } from "@/middlewares/auth";
import { VISIT_STAFF } from "@/routes/encounters/encounters.routes";
import { facilityHeaders, tenantResponses } from "@/routes/facility/facility.routes";
import { QUEUE_STAFF } from "@/routes/queues/queues.routes";

/**
 * Appointments (P3 slice 6): booked at a clinic for a day, moved, cancelled,
 * and checked in on the day, which opens the visit. Front desk and clinical
 * staff do all of it; none is a clinical act. A ward nurse books a follow-up
 * at discharge but does not check a patient in, since checking in opens a
 * visit, which ward nurses do not.
 */
const tags = ["Appointments"];

const bookingStaff = requireMembershipRole(...QUEUE_STAFF);
const visitStaff = requireMembershipRole(...VISIT_STAFF);

const RefusalSchema = z.object({ message: z.string(), code: z.string() });
const IdParamsSchema = z.object({ id: z.uuid() });
const oneLine = (max: number) => z.string().trim().min(1).max(max).regex(/^\P{C}+$/u, "One line");
const DateSchema = z.iso.date();
const TimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "HH:MM, 24-hour, Kenyan time");
const StatusSchema = z.enum(["booked", "checked_in", "cancelled"]);

export const AppointmentSchema = z.object({
  id: z.uuid(),
  patientId: z.uuid(),
  servicePointId: z.uuid(),
  clinicianId: z.uuid().nullable(),
  date: z.string(),
  time: z.string().nullable(),
  status: StatusSchema,
  /** Still booked after its day. */
  missed: z.boolean(),
  bookedAt: z.string(),
  /** The visit or admission it was booked during, if any. */
  bookedDuring: z.uuid().nullable(),
  checkedInAt: z.string().nullable(),
  /** The visit it was checked into. */
  encounterId: z.uuid().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
});

const ListedSchema = z.object({
  id: z.uuid(),
  patient: z.object({
    id: z.uuid(),
    name: z.string(),
    opNumber: z.string().nullable(),
    sex: z.enum(["male", "female", "intersex"]).nullable(),
    ageYears: z.number().int(),
  }),
  servicePoint: z.object({ id: z.uuid(), name: z.string() }),
  clinician: z.object({ membershipId: z.uuid(), name: z.string() }).nullable(),
  date: z.string(),
  time: z.string().nullable(),
  status: StatusSchema,
  missed: z.boolean(),
  bookedAt: z.string(),
  encounterId: z.uuid().nullable(),
});

const ListSchema = z.object({
  appointments: z.array(ListedSchema),
  /** How many match, beyond this page too. */
  total: z.number().int(),
});

const BookBodySchema = z.strictObject({
  patientId: z.uuid(),
  /** The clinic: a consultation point. */
  servicePointId: z.uuid(),
  /** A doctor, clinical officer or nurse, if the patient is to see someone in particular. */
  clinicianId: z.uuid().optional(),
  date: DateSchema,
  time: TimeSchema.optional(),
  /**
   * Whether the patient wants an SMS reminder the day before. Required the
   * first time for a patient with a phone; given again, it changes the answer.
   */
  smsReminders: z.boolean().optional(),
});
const MoveBodySchema = z.strictObject({
  date: DateSchema,
  /** Left out, the appointment has no time. */
  time: TimeSchema.optional(),
});
const CancelBodySchema = z.strictObject({ reason: oneLine(200) });
const CheckInBodySchema = z.strictObject({
  /**
   * Where the patient goes: left out, the facility's triage point, as for any
   * visit; a clinic's id, straight there; null, no queue.
   */
  queueAt: z.uuid().nullable().optional(),
});
const DayQuerySchema = z.object({
  /** Today if left out. */
  date: DateSchema.optional(),
  servicePointId: z.uuid().optional(),
  clinicianId: z.uuid().optional(),
  offset: z.coerce.number().int().min(0).default(0),
});
const OffsetQuerySchema = z.object({ offset: z.coerce.number().int().min(0).default(0) });
const SmsBodySchema = z.strictObject({ wanted: z.boolean() });

const refusals = {
  [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Not possible as things stand"),
};

export const bookAppointment = createRoute({
  tags,
  method: "post",
  path: "/appointments",
  summary: "Book an appointment",
  description:
    "At a clinic, for a day from today to a year ahead, with a time and a "
    + "clinician if wanted. A patient booked during a visit or admission has "
    + "it recorded. The SMS reminder goes at 17:00 the day before, to a "
    + "patient who said yes (`sms_answer_needed` until they have been asked).",
  middleware: [bookingStaff] as const,
  request: { headers: facilityHeaders, body: jsonContentRequired(BookBodySchema, "The booking") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(AppointmentSchema, "Booked"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(BookBodySchema), "Invalid booking"),
    ...tenantResponses,
  },
});

export const listDay = createRoute({
  tags,
  method: "get",
  path: "/appointments",
  summary: "A day's appointments",
  description:
    "At one clinic or with one clinician if asked, by time (those with none "
    + "last), 200 at a time: pass `offset` for the next page. Cancelled ones "
    + "are left out. Audited, since it names patients.",
  middleware: [bookingStaff] as const,
  request: { headers: facilityHeaders, query: DayQuerySchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(ListSchema, "The day's appointments"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(DayQuerySchema), "Invalid request"),
    ...tenantResponses,
  },
});

export const moveAppointment = createRoute({
  tags,
  method: "post",
  path: "/appointments/{id}/move",
  summary: "Move an appointment",
  description: "To another day or time while it is booked, audited with the old and new. The reminder follows it.",
  middleware: [bookingStaff] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(MoveBodySchema, "When") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(AppointmentSchema, "Moved"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(MoveBodySchema), "Invalid request"),
    ...tenantResponses,
  },
});

export const cancelAppointment = createRoute({
  tags,
  method: "post",
  path: "/appointments/{id}/cancel",
  summary: "Cancel an appointment",
  middleware: [bookingStaff] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(CancelBodySchema, "Why") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(AppointmentSchema, "Cancelled"),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(CancelBodySchema), "Invalid request"),
    ...tenantResponses,
  },
});

export const checkIn = createRoute({
  tags,
  method: "post",
  path: "/appointments/{id}/check-in",
  summary: "Check a patient in",
  description:
    "On the appointment's own day. Opens the patient's outpatient visit, or "
    + "uses the one already open, and sends them to triage like any visit, "
    + "or straight to the clinic named. Joining a clinic with a fee charges it.",
  middleware: [visitStaff] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(CheckInBodySchema, "Where the patient goes") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({ appointment: AppointmentSchema, encounterId: z.uuid(), openedVisit: z.boolean() }),
      "Checked in",
    ),
    ...refusals,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(CheckInBodySchema), "Invalid request"),
    ...tenantResponses,
  },
});

export const patientAppointments = createRoute({
  tags,
  method: "get",
  path: "/patients/{id}/appointments",
  summary: "A patient's appointments",
  description: "Latest day first, cancelled ones included, 50 at a time. Audited.",
  middleware: [bookingStaff] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, query: OffsetQuerySchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(ListSchema, "Their appointments"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(OffsetQuerySchema), "Invalid request"),
    ...tenantResponses,
  },
});

export const setSmsReminders = createRoute({
  tags,
  method: "put",
  path: "/patients/{id}/sms-reminders",
  summary: "Record whether a patient wants SMS reminders",
  description: "Audited with the old answer. Nothing is sent without a yes.",
  middleware: [bookingStaff] as const,
  request: { headers: facilityHeaders, params: IdParamsSchema, body: jsonContentRequired(SmsBodySchema, "Their answer") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ smsReminders: z.boolean() }), "Recorded"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(createErrorSchema(SmsBodySchema), "Invalid request"),
    ...tenantResponses,
  },
});

export type BookAppointmentRoute = typeof bookAppointment;
export type ListDayRoute = typeof listDay;
export type MoveAppointmentRoute = typeof moveAppointment;
export type CancelAppointmentRoute = typeof cancelAppointment;
export type CheckInRoute = typeof checkIn;
export type PatientAppointmentsRoute = typeof patientAppointments;
export type SetSmsRemindersRoute = typeof setSmsReminders;
