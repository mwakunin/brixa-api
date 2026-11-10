import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { EncounterDetail } from "@/lib/encounters";
import type { PatientActor } from "@/lib/patients";
import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import * as encounters from "@/lib/encounters";
import { queueRefusal } from "@/routes/queues/queues.handlers";

import type {
  AdmitPatientRoute,
  CancelEncounterRoute,
  CloseEncounterRoute,
  DischargePatientRoute,
  GetEncounterRoute,
  ListEncountersRoute,
  OpenEncounterRoute,
  TransferPatientRoute,
} from "./encounters.routes";

function actorOf(c: Context<TenantBindings>): PatientActor {
  return { userId: c.var.user!.id, membershipId: c.var.membership.id };
}

function iso(d: Date | null) {
  return d ? d.toISOString() : null;
}

function encounterJson(e: EncounterDetail) {
  return {
    id: e.id,
    patientId: e.patientId,
    kind: e.kind,
    status: e.status,
    startedAt: e.startedAt.toISOString(),
    endedAt: iso(e.endedAt),
    cancelReason: e.cancelReason,
    parentEncounterId: e.parentEncounterId,
    queue: e.queue && { ...e.queue, joinedAt: e.queue.joinedAt.toISOString(), servingAt: iso(e.queue.servingAt) },
    attending: e.attending,
    admission: e.admission && {
      admissionNumber: e.admission.admissionNumber,
      admittedAt: e.admission.admittedAt.toISOString(),
      dischargedAt: iso(e.admission.dischargedAt),
      dischargeDisposition: e.admission.dischargeDisposition,
      stays: e.admission.stays.map(s => ({ ...s, startedAt: s.startedAt.toISOString(), endedAt: iso(s.endedAt) })),
    },
  };
}

const NOT_FOUND = new Set(["patient_not_found", "not_found", "bed_not_found"]);

/** The refusal an encounter error answers with, or null to let it through. */
function refusal(c: Context<TenantBindings>, err: unknown) {
  const queued = queueRefusal(c, err);
  if (queued)
    return queued;
  if (!(err instanceof encounters.EncounterError))
    return null;
  if (NOT_FOUND.has(err.code))
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
  return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
}

/** Runs `act`, answering with the encounter afterwards, or with the refusal. */
async function answer<S extends 200 | 201>(c: Context<TenantBindings>, id: () => Promise<string>, status: S) {
  try {
    const encounterId = await id();
    return c.json(encounterJson(await encounters.encounterDetail(c.var.db, encounterId)), status);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
}

export const openEncounter: TenantRouteHandler<OpenEncounterRoute> = async (c) => {
  const body = c.req.valid("json");
  return answer(c, async () => (await encounters.openEncounter(c.var.db, c.var.facility.id, body, actorOf(c))).id, HttpStatusCodes.CREATED);
};

export const listEncounters: TenantRouteHandler<ListEncountersRoute> = async (c) => {
  const { patientId, offset } = c.req.valid("query");
  try {
    const found = await encounters.listEncounters(c.var.db, c.var.facility.id, patientId, actorOf(c), offset);
    return c.json({ encounters: found.map(encounterJson) }, HttpStatusCodes.OK);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};

export const getEncounter: TenantRouteHandler<GetEncounterRoute> = async (c) => {
  const { id } = c.req.valid("param");
  try {
    return c.json(encounterJson(await encounters.viewEncounter(c.var.db, c.var.facility.id, id, actorOf(c))), HttpStatusCodes.OK);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};

export const closeEncounter: TenantRouteHandler<CloseEncounterRoute> = async (c) => {
  const { id } = c.req.valid("param");
  return answer(c, async () => (await encounters.closeEncounter(c.var.db, c.var.facility.id, id, actorOf(c))).id, HttpStatusCodes.OK);
};

export const cancelEncounter: TenantRouteHandler<CancelEncounterRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { reason } = c.req.valid("json");
  return answer(c, async () => (await encounters.cancelEncounter(c.var.db, c.var.facility.id, id, reason, actorOf(c))).id, HttpStatusCodes.OK);
};

export const admitPatient: TenantRouteHandler<AdmitPatientRoute> = async (c) => {
  const body = c.req.valid("json");
  return answer(c, async () => (await encounters.admitPatient(c.var.db, c.var.facility.id, body, actorOf(c))).encounterId, HttpStatusCodes.CREATED);
};

export const transferPatient: TenantRouteHandler<TransferPatientRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { bedId } = c.req.valid("json");
  return answer(c, async () => {
    await encounters.transferPatient(c.var.db, c.var.facility.id, id, bedId, actorOf(c));
    return id;
  }, HttpStatusCodes.OK);
};

export const dischargePatient: TenantRouteHandler<DischargePatientRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { disposition } = c.req.valid("json");
  return answer(c, async () => {
    await encounters.dischargePatient(c.var.db, c.var.facility.id, id, disposition, actorOf(c));
    return id;
  }, HttpStatusCodes.OK);
};
