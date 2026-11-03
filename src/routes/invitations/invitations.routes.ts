import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/accounts";
import { rateLimits } from "@/middlewares/rate-limit";

const tags = ["Invitations"];

const RefusalSchema = z.object({ message: z.string(), code: z.string() });

export const acceptInvitation = createRoute({
  tags,
  method: "post",
  path: "/invitations/accept",
  summary: "Accept an invitation",
  description:
    "Called by the staff app's accept page with the token from the emailed "
    + "link. No session and no facility header: the token names the "
    + "invitation. Someone new sets their password here; someone who already "
    + "has an account omits it, keeps their password, and gains the "
    + "membership. When `accountCreated` is false, any password sent was not "
    + "used: the person signs in with the password they already have.",
  middleware: [rateLimits.invitation()] as const,
  request: {
    body: jsonContentRequired(z.object({
      token: z.string().min(20).max(200),
      password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH).optional(),
    }), "The link's token, and a password for a new account"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({
      facilityId: z.uuid(),
      facilityName: z.string(),
      /** False when the person already had an account and kept its password. */
      accountCreated: z.boolean(),
    }), "Accepted; sign in next"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(RefusalSchema, "The facility is suspended"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(RefusalSchema, "Not a valid link (unknown, revoked or replaced)"),
    [HttpStatusCodes.CONFLICT]: jsonContent(RefusalSchema, "Already accepted"),
    [HttpStatusCodes.GONE]: jsonContent(RefusalSchema, "Expired"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(RefusalSchema, "A new account needs a password"),
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(
      z.object({ message: z.string(), retryAfterSeconds: z.number().int().positive() }),
      "Too many attempts",
    ),
  },
});

export type AcceptInvitationRoute = typeof acceptInvitation;
