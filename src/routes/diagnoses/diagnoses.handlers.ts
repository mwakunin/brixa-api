import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import * as dx from "@/lib/diagnoses";
import { searchIcd as findIcd } from "@/lib/icd11";

import type {
  ConfirmDiagnosisRoute,
  EndDiagnosisRoute,
  ListDiagnosesRoute,
  MakePrincipalRoute,
  RecordDiagnosisRoute,
  SearchIcdRoute,
} from "./diagnoses.routes";

function actorOf(c: Context<TenantBindings>) {
  return { userId: c.var.user!.id, membershipId: c.var.membership.id };
}

/** Refusals about the code typed read as a validation failure on `code`. */
const ABOUT_THE_CODE = new Set<dx.DiagnosisErrorCode>(["code_not_found", "code_too_broad", "code_retired"]);

function refusal(c: Context, err: unknown) {
  if (!(err instanceof dx.DiagnosisError))
    return null;
  if (err.code === "encounter_not_found" || err.code === "not_found")
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
  if (ABOUT_THE_CODE.has(err.code)) {
    return c.json({
      success: false as const,
      error: { name: "ValidationError", issues: [{ code: "custom" as const, path: ["code"], message: err.message }] },
    }, HttpStatusCodes.UNPROCESSABLE_ENTITY);
  }
  return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
}

type Listed = Awaited<ReturnType<typeof dx.diagnosesOf>>[number];

function diagnosisJson(d: Listed) {
  return {
    ...d,
    diagnosedAt: d.diagnosedAt.toISOString(),
    confirmedAt: d.confirmedAt?.toISOString() ?? null,
    endedAt: d.endedAt?.toISOString() ?? null,
  };
}

/** Runs a change, answering with the diagnosis as the list shows it, without a second audit entry. */
async function answer(c: Context<TenantBindings>, act: () => Promise<{ id: string; encounterId: string }>, status: 200 | 201 = HttpStatusCodes.OK) {
  try {
    const changed = await act();
    const shown = (await dx.diagnosesOf(c.var.db, changed.encounterId)).find(d => d.id === changed.id)!;
    return c.json(diagnosisJson(shown), status);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused;
    throw err;
  }
}

export const searchIcd: TenantRouteHandler<SearchIcdRoute> = async (c) => {
  const { q } = c.req.valid("query");
  return c.json({ codes: await findIcd(c.var.db, q) }, HttpStatusCodes.OK);
};

export const recordDiagnosis: TenantRouteHandler<RecordDiagnosisRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  return answer(c, () => dx.recordDiagnosis(c.var.db, c.var.facility.id, id, body, actorOf(c)), HttpStatusCodes.CREATED) as never;
};

export const listDiagnoses: TenantRouteHandler<ListDiagnosesRoute> = async (c) => {
  const { id } = c.req.valid("param");
  try {
    const listed = await dx.listDiagnoses(c.var.db, c.var.facility.id, id, actorOf(c));
    return c.json({ diagnoses: listed.map(diagnosisJson) }, HttpStatusCodes.OK);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused as never;
    throw err;
  }
};

export const confirmDiagnosis: TenantRouteHandler<ConfirmDiagnosisRoute> = async (c) => {
  const { id } = c.req.valid("param");
  return answer(c, () => dx.confirmDiagnosis(c.var.db, c.var.facility.id, id, actorOf(c))) as never;
};

export const makePrincipal: TenantRouteHandler<MakePrincipalRoute> = async (c) => {
  const { id } = c.req.valid("param");
  return answer(c, () => dx.makePrincipal(c.var.db, c.var.facility.id, id, actorOf(c))) as never;
};

export const endDiagnosis: TenantRouteHandler<EndDiagnosisRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { reason } = c.req.valid("json");
  return answer(c, () => dx.endDiagnosis(c.var.db, c.var.facility.id, id, reason, actorOf(c))) as never;
};
