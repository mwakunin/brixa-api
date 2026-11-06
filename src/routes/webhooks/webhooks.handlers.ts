import type { AppRouteHandler } from "@/lib/types";

import { onC2bConfirmation, onC2bValidation, onStkCallback } from "@/lib/mpesa-callbacks";

import type { C2bConfirmationRoute, C2bValidationRoute, StkCallbackRoute } from "./webhooks.routes";

export const c2bConfirmation: AppRouteHandler<C2bConfirmationRoute> = async (c) => {
  const answer = await onC2bConfirmation(c.req.valid("param").token, c.req.valid("json"));
  return c.json(answer.body, answer.status);
};

export const c2bValidation: AppRouteHandler<C2bValidationRoute> = async (c) => {
  const answer = await onC2bValidation(c.req.valid("param").token);
  return c.json(answer.body, answer.status);
};

export const stkCallback: AppRouteHandler<StkCallbackRoute> = async (c) => {
  const answer = await onStkCallback(c.req.valid("param").token, c.req.valid("json"));
  return c.json(answer.body, answer.status);
};
