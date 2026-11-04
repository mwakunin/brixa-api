import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { DemographicChanges, PatientActor, PatientRecord, PatientSummary } from "@/lib/patients";
import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import { ageInYears, dateOfBirthForAge } from "@/lib/dates";
import { isCheckViolation, pgConstraintName } from "@/lib/db-errors";
import * as patients from "@/lib/patients";
import { normalizePhone } from "@/lib/phone";

import type {
  AddIdentifierRoute,
  GetPatientRoute,
  RegisterPatientRoute,
  SearchPatientsRoute,
  UpdatePatientRoute,
} from "./patients.routes";

function actorOf(c: Context<TenantBindings>): PatientActor {
  return { userId: c.var.user!.id, membershipId: c.var.membership.id };
}

function summaryJson(p: PatientSummary) {
  return { ...p, age: ageInYears(p.dateOfBirth) };
}

function recordJson(r: PatientRecord) {
  return {
    id: r.id,
    givenName: r.givenName,
    middleNames: r.middleNames,
    familyName: r.familyName,
    sex: r.sex,
    dateOfBirth: r.dateOfBirth,
    age: ageInYears(r.dateOfBirth),
    dobIsEstimated: r.dobIsEstimated,
    phone: r.phone,
    noPhoneReason: r.noPhoneReason,
    noIdReason: r.noIdReason,
    unidentified: r.unidentified,
    registeredAt: r.registeredAt.toISOString(),
    numbers: r.numbers.map(n => ({ ...n, issuedAt: n.issuedAt.toISOString() })),
    identifiers: r.identifiers.map(i => ({ ...i, addedAt: i.addedAt.toISOString() })),
  };
}

/** The rule each registration CHECK holds, as the clerk should read it. */
const RULES: Record<string, string> = {
  patients_sex_unless_unidentified: "Sex is required once a patient is identified",
  patients_unidentified_reasons: "Replace the 'unidentified' reason for the missing phone or ID",
  patients_phone_or_reason: "Give a phone number, or the reason there is none",
};

/** A refusal the route declares, or null to let the error through. */
function refusal(c: Context<TenantBindings>, err: unknown) {
  if (err instanceof patients.PatientError) {
    if (err.code === "not_found")
      return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
    return c.json({
      code: "possible_duplicate" as const,
      message: err.message,
      candidates: err.candidates.map(summaryJson),
    }, HttpStatusCodes.CONFLICT);
  }

  const rule = isCheckViolation(err) ? RULES[pgConstraintName(err) ?? ""] : undefined;
  if (rule) {
    return c.json({
      success: false as const,
      error: { name: "ValidationError", issues: [{ code: "custom" as const, path: [], message: rule }] },
    }, HttpStatusCodes.UNPROCESSABLE_ENTITY);
  }

  return null;
}

export const registerPatient: TenantRouteHandler<RegisterPatientRoute> = async (c) => {
  const body = c.req.valid("json");
  const dateOfBirth = body.dateOfBirth ?? dateOfBirthForAge(body.estimatedAgeYears!);

  try {
    const { id } = await patients.registerPatient(c.var.db, c.var.facility.id, {
      givenName: body.givenName,
      middleNames: body.middleNames,
      familyName: body.familyName,
      sex: body.sex,
      dateOfBirth,
      dobIsEstimated: body.dateOfBirth === undefined,
      phone: body.phone ? normalizePhone(body.phone) : null,
      noPhoneReason: body.noPhoneReason ?? null,
      identifiers: body.identifiers,
      noIdReason: body.noIdReason ?? null,
      unidentified: body.unidentified,
      confirmNotDuplicate: body.confirmNotDuplicate,
    }, actorOf(c));

    const record = await patients.patientRecord(c.var.db, id);
    return c.json(recordJson(record!), HttpStatusCodes.CREATED);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};

export const searchPatients: TenantRouteHandler<SearchPatientsRoute> = async (c) => {
  const { q } = c.req.valid("query");
  const found = await patients.searchPatients(c.var.db, c.var.facility.id, q, actorOf(c));
  return c.json({ patients: found.map(summaryJson) }, HttpStatusCodes.OK);
};

export const getPatient: TenantRouteHandler<GetPatientRoute> = async (c) => {
  const { id } = c.req.valid("param");
  try {
    const record = await patients.viewPatient(c.var.db, c.var.facility.id, id, actorOf(c));
    return c.json(recordJson(record), HttpStatusCodes.OK);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};

export const updatePatient: TenantRouteHandler<UpdatePatientRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { estimatedAgeYears, phone, ...body } = c.req.valid("json");

  const changes: DemographicChanges = { ...body };
  if (estimatedAgeYears !== undefined) {
    changes.dateOfBirth = dateOfBirthForAge(estimatedAgeYears);
    changes.dobIsEstimated = true;
  }
  else if (body.dateOfBirth !== undefined) {
    changes.dobIsEstimated = false;
  }
  if (phone !== undefined)
    changes.phone = normalizePhone(phone);
  // Saying there is no phone any more removes the old one.
  else if (body.noPhoneReason !== undefined)
    changes.phone = null;

  try {
    const record = await patients.updatePatient(c.var.db, c.var.facility.id, id, changes, actorOf(c));
    return c.json(recordJson(record), HttpStatusCodes.OK);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};

export const addIdentifier: TenantRouteHandler<AddIdentifierRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  try {
    const record = await patients.addIdentifier(c.var.db, c.var.facility.id, id, body, actorOf(c));
    return c.json(recordJson(record), HttpStatusCodes.OK);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};
