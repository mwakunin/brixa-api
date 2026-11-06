import type { Context } from "hono";

import type { AppBindings, AppRouteHandler } from "@/lib/types";

import { isListedCallbackSource } from "@/lib/daraja";
import { onC2bConfirmation, onC2bValidation, onStkCallback } from "@/lib/mpesa-callbacks";
import { callerAddress } from "@/middlewares/rate-limit";

import type { C2bConfirmationRoute, C2bValidationRoute, StkCallbackRoute } from "./webhooks.routes";

/**
 * Safaricom signs nothing and its published addresses change, so an
 * unlisted source is logged, never refused: the token in the path is the
 * control, and refusing a real payment is the worse failure.
 */
function noteSource(c: Context<AppBindings>) {
  const address = callerAddress(c);
  if (!isListedCallbackSource(address))
    c.var.logger.warn({ sourceIp: address ?? null, path: c.req.routePath }, "M-Pesa callback from an unlisted address");
}

export const c2bConfirmation: AppRouteHandler<C2bConfirmationRoute> = async (c) => {
  noteSource(c);
  const answer = await onC2bConfirmation(c.req.valid("param").token, c.req.valid("json"));
  return c.json(answer.body, answer.status);
};

export const c2bValidation: AppRouteHandler<C2bValidationRoute> = async (c) => {
  noteSource(c);
  const answer = await onC2bValidation(c.req.valid("param").token);
  return c.json(answer.body, answer.status);
};

export const stkCallback: AppRouteHandler<StkCallbackRoute> = async (c) => {
  noteSource(c);
  const answer = await onStkCallback(c.req.valid("param").token, c.req.valid("json"));
  return c.json(answer.body, answer.status);
};
