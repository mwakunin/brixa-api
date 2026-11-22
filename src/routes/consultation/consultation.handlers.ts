import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { Complaint } from "@/lib/consultation";
import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import * as consultation from "@/lib/consultation";
import { ageInYears } from "@/lib/dates";
import { restrictedJson } from "@/lib/validation";
import { allergyJson } from "@/routes/allergies/allergies.handlers";
import { diagnosisJson } from "@/routes/diagnoses/diagnoses.handlers";
import { resultJson } from "@/routes/lab/lab.handlers";
import { noteJson } from "@/routes/notes/notes.handlers";
import { readingJson } from "@/routes/observations/observations.handlers";
import { orderJson } from "@/routes/orders/order-schemas";

import type { RecordComplaintRoute, ViewConsultationRoute } from "./consultation.routes";

function actorOf(c: Context<TenantBindings>) {
  return { userId: c.var.user!.id, membershipId: c.var.membership.id };
}

export function consultationRefusal(c: Context, err: unknown): Response | null {
  if (!(err instanceof consultation.ConsultationError))
    return null;
  if (err.code === "not_found")
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
  return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
}

function complaintJson(complaint: Complaint) {
  return { ...complaint, recordedAt: complaint.recordedAt.toISOString() };
}

export const viewConsultation: TenantRouteHandler<ViewConsultationRoute> = async (c) => {
  const { id } = c.req.valid("param");
  try {
    const seen = await consultation.viewConsultation(c.var.db, c.var.facility.id, id, actorOf(c));
    return c.json({
      encounter: { ...seen.encounter, startedAt: seen.encounter.startedAt.toISOString() },
      patient: { ...seen.patient, age: ageInYears(seen.patient.dateOfBirth) },
      complaint: seen.complaint && complaintJson(seen.complaint),
      vitals: seen.vitals.map(readingJson),
      allergies: seen.allergies.map(allergyJson),
      notes: seen.notes.map(noteJson),
      diagnoses: seen.diagnoses.map(diagnosisJson),
      orders: seen.orders.map(orderJson),
      results: seen.results.map(resultJson),
      reports: seen.reports,
      restricted: restrictedJson(seen.restricted),
      lastVisit: seen.lastVisit && { ...seen.lastVisit, startedAt: seen.lastVisit.startedAt.toISOString() },
    }, HttpStatusCodes.OK);
  }
  catch (err) {
    const refused = consultationRefusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};

export const recordComplaint: TenantRouteHandler<RecordComplaintRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { text } = c.req.valid("json");
  try {
    const complaint = await consultation.recordComplaint(c.var.db, c.var.facility.id, id, text, actorOf(c));
    return c.json({ complaint: complaintJson(complaint) }, HttpStatusCodes.OK);
  }
  catch (err) {
    const refused = consultationRefusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};
