import type { Context } from "hono";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { TenantBindings, TenantRouteHandler } from "@/lib/types";

import * as lab from "@/lib/lab-catalogue";

import type {
  AddAnalyteRoute,
  CreateLabTestRoute,
  ListLabTestsRoute,
  SetReferenceRangesRoute,
  UpdateAnalyteRoute,
  UpdateLabTestRoute,
} from "./lab-tests.routes";

function actorOf(c: Context<TenantBindings>) {
  return { userId: c.var.user!.id, membershipId: c.var.membership.id };
}

function refusal(c: Context, err: unknown) {
  if (!(err instanceof lab.LabCatalogueError))
    return null;
  if (err.code === "not_found" || err.code === "analyte_not_found")
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
  return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
}

/** Runs a change, answering with its test as the catalogue shows it. */
async function answer(c: Context<TenantBindings>, act: () => Promise<{ labTestId: string } | { id: string; billableItemId: string }>, status: 200 | 201 = HttpStatusCodes.OK) {
  try {
    const changed = await act();
    const testId = "labTestId" in changed ? changed.labTestId : changed.id;
    return c.json(await lab.labTestShown(c.var.db, testId), status);
  }
  catch (err) {
    const refused = refusal(c, err);
    if (refused)
      return refused;
    throw err;
  }
}

export const listLabTests: TenantRouteHandler<ListLabTestsRoute> = async (c) => {
  return c.json({ tests: await lab.listLabTests(c.var.db) }, HttpStatusCodes.OK);
};

export const createLabTest: TenantRouteHandler<CreateLabTestRoute> = async (c) => {
  const body = c.req.valid("json");
  return answer(c, () => lab.createLabTest(c.var.db, c.var.facility.id, body, actorOf(c)), HttpStatusCodes.CREATED) as never;
};

export const updateLabTest: TenantRouteHandler<UpdateLabTestRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  return answer(c, () => lab.updateLabTest(c.var.db, c.var.facility.id, id, body, actorOf(c))) as never;
};

export const addAnalyte: TenantRouteHandler<AddAnalyteRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  return answer(c, () => lab.addAnalyte(c.var.db, c.var.facility.id, id, body, actorOf(c)), HttpStatusCodes.CREATED) as never;
};

export const updateAnalyte: TenantRouteHandler<UpdateAnalyteRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  return answer(c, () => lab.updateAnalyte(c.var.db, c.var.facility.id, id, body, actorOf(c))) as never;
};

export const setReferenceRanges: TenantRouteHandler<SetReferenceRangesRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { ranges } = c.req.valid("json");
  return answer(c, () => lab.setReferenceRanges(c.var.db, c.var.facility.id, id, ranges, actorOf(c))) as never;
};
