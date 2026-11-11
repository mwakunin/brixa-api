import type { Context } from "hono";

import { and, eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";
import { z } from "zod";

import type { AppDb } from "@/db";
import type { TenantBindings } from "@/lib/types";

import { facilities, memberships } from "@/db/schema";
import { runAsFacility } from "@/db/tenant-transaction";
import { FACILITY_HEADER } from "@/lib/constants";

/**
 * Tenant resolution (CLAUDE.md §4): the facility comes from the signed-in
 * user's membership, named per request in the X-Facility-Id header. The
 * hostname plays no part.
 *
 * Order of work inside one transaction on the app connection:
 *
 *   1. set `app.facility_id` to the requested facility
 *   2. read the facility and this user's active membership, UNDER RLS
 *   3. refuse, or hand the transaction to the handler as `c.var.db`
 *
 * Step 2 needs no owner-connection read. Once the setting is in place, the
 * policies themselves limit the lookup to the one facility asked for, so a
 * membership elsewhere cannot be mistaken for one here. The explicit filters
 * below say the same thing in the query; `rls.test.ts` proves the database
 * would enforce it without them.
 */

const NOT_FOUND_MESSAGE = "No facility found";

const facilityIdSchema = z.uuid();

/** The facility and the caller's active membership there, if any. */
async function loadAccess(tx: AppDb, facilityId: string, userId: string) {
  const [facility] = await tx
    .select({
      id: facilities.id,
      name: facilities.name,
      status: facilities.status,
    })
    .from(facilities)
    .where(eq(facilities.id, facilityId))
    .limit(1);

  const [membership] = await tx
    .select({
      id: memberships.id,
      facilityId: memberships.facilityId,
      roles: memberships.roles,
      licenceExpiresOn: memberships.licenceExpiresOn,
    })
    .from(memberships)
    .where(and(
      eq(memberships.facilityId, facilityId),
      eq(memberships.userId, userId),
      eq(memberships.isActive, true),
    ))
    .limit(1);

  return { facility, membership };
}

/**
 * Why the request may not proceed, or null if it may.
 *
 * No membership is a 404, the same answer as no facility: a signed-in
 * stranger must not be able to tell a facility that exists from one that
 * does not. A member of a suspended facility gets a 403 that says why, since
 * they already know it exists and need to know why they are locked out.
 */
function refusal(c: Context, access: Awaited<ReturnType<typeof loadAccess>>) {
  if (!access.facility || !access.membership)
    return c.json({ message: NOT_FOUND_MESSAGE }, HttpStatusCodes.NOT_FOUND);

  if (access.facility.status === "suspended") {
    return c.json(
      { message: "This facility's account is suspended. Please contact support." },
      HttpStatusCodes.FORBIDDEN,
    );
  }

  return null;
}

/**
 * Opens the tenant transaction for the facility the request names.
 *
 * `set_config(..., true)` scopes the setting to the transaction, so it is
 * discarded at COMMIT or ROLLBACK and cannot reach the next borrower of the
 * pooled connection (CLAUDE.md §4, layer 2). Holding the transaction across
 * `await next()` also makes each request atomic.
 *
 * Requires `withSession` to have run (it is app-wide).
 */
export const withFacility = createMiddleware<TenantBindings>(async (c, next) => {
  /*
   * One transaction per request, however many routers register this. Each
   * tenant router mounts at `/` with middleware at `/*`, so without this guard
   * a request would open one transaction per router it passed, on one pooled
   * connection each, and exhaust the pool (measured in the school SaaS).
   */
  if (c.var.db)
    return next();

  const user = c.var.user;
  if (!user) {
    return c.json(
      { message: HttpStatusPhrases.UNAUTHORIZED },
      HttpStatusCodes.UNAUTHORIZED,
    );
  }

  const requested = c.req.header(FACILITY_HEADER);
  if (!requested) {
    return c.json(
      { message: `Choose a facility: send its id in the ${FACILITY_HEADER} header` },
      HttpStatusCodes.BAD_REQUEST,
    );
  }

  // Not a uuid cannot be a facility. Answered like any unknown facility, so
  // the header's format is not a probe.
  const parsed = facilityIdSchema.safeParse(requested);
  if (!parsed.success)
    return c.json({ message: NOT_FOUND_MESSAGE }, HttpStatusCodes.NOT_FOUND);

  // The header value reaches `set_config` as a bind parameter (db/tenant-
  // transaction.ts), so nothing in it can escape into the statement.
  const refused = await runAsFacility(parsed.data, async (tx): Promise<Response | null> => {
    const access = await loadAccess(tx, parsed.data, user.id);
    const refusing = refusal(c, access);
    if (refusing)
      return refusing;

    c.set("facility", access.facility!);
    c.set("membership", access.membership!);
    c.set("db", tx);

    await next();

    /*
     * A handler that returns 4xx/5xx without throwing would otherwise commit
     * what it wrote first. Rolling back on an error status keeps "the request
     * failed" and "nothing was persisted" the same statement.
     *
     * Consequence for auditing: an entry recording a REFUSAL (a denied
     * break-glass attempt, rule 27) written on this transaction is rolled back
     * with everything else. Such entries must be written in their own short
     * transaction, never through `c.var.db`.
     */
    if (c.res.status >= 400)
      throw new RollbackOnErrorStatus(c.res.status);

    return null;
  }).catch((err) => {
    // The rollback did its job; the response the handler built still stands.
    if (err instanceof RollbackOnErrorStatus)
      return null;
    throw err;
  });

  if (refused)
    return refused;
});

/** Internal signal: unwind the transaction but keep the handler's response. */
class RollbackOnErrorStatus extends Error {
  constructor(readonly status: number) {
    super(`Rolled back on ${status}`);
    this.name = "RollbackOnErrorStatus";
  }
}
