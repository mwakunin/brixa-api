import { Hono } from "hono";
import * as HttpStatusCodes from "stoker/http-status-codes";

import { hardenedHeaders, staffAppCors } from "./create-app";
import { STARTING_UP_MESSAGE, STARTING_UP_RETRY_AFTER } from "./startup-gate";

/**
 * The startup gate's 503 (lib/startup-gate.ts), sent through the same
 * hardened headers and staff-app CORS as every answer the app gives. The gate
 * answers before the app runs, so without this the first responses of a new
 * instance would be the only ones without HSTS, and the staff app could not
 * read them: it would see a network error rather than "starting up".
 */
const startingUp = new Hono()
  .use(hardenedHeaders())
  .use(staffAppCors())
  .all("*", (c) => {
    c.header("Retry-After", STARTING_UP_RETRY_AFTER);
    return c.json({ message: STARTING_UP_MESSAGE }, HttpStatusCodes.SERVICE_UNAVAILABLE);
  });

export function startingUpResponse(request: Request): Response | Promise<Response> {
  return startingUp.fetch(request);
}
