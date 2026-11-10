import { createMiddleware } from "hono/factory";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { ClinicalRole } from "@/lib/professions";
import type { AppBindings, Membership, MembershipRole, TenantBindings, UserRole } from "@/lib/types";

import { auth } from "@/lib/auth";
import { businessDate, printedDate } from "@/lib/dates";

/**
 * Resolves the Better Auth session (if any) onto the context. Always runs and
 * never rejects: routes decide whether a session is required.
 */
export const withSession = createMiddleware<AppBindings>(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });

  c.set("user", session?.user ?? null);
  c.set("session", session?.session ?? null);

  await next();
});

/** Rejects anyone without a valid session. */
export const requireAuth = createMiddleware<AppBindings>(async (c, next) => {
  if (!c.var.user) {
    return c.json(
      { message: HttpStatusPhrases.UNAUTHORIZED },
      HttpStatusCodes.UNAUTHORIZED,
    );
  }

  await next();
});

/**
 * Rejects anyone whose PLATFORM role isn't in `allowed`: in practice, the
 * superadmin plane and nothing else. Inside a facility, use
 * `requireMembershipRole`; the global role cannot say "cashier at this
 * hospital".
 */
export function requireRole(...allowed: UserRole[]) {
  return createMiddleware<AppBindings>(async (c, next) => {
    const user = c.var.user;

    if (!user) {
      return c.json(
        { message: HttpStatusPhrases.UNAUTHORIZED },
        HttpStatusCodes.UNAUTHORIZED,
      );
    }

    if (!allowed.includes(user.role as UserRole)) {
      return c.json(
        { message: HttpStatusPhrases.FORBIDDEN },
        HttpStatusCodes.FORBIDDEN,
      );
    }

    await next();
  });
}

/**
 * Rejects anyone who holds none of `allowed` at the facility being addressed.
 *
 * Roles are a set: a doctor who is also the facility admin holds both, so this
 * asks whether the two sets intersect. `withFacility` has already refused a
 * caller with no membership here (404), so reaching this guard means the
 * caller is a member and an honest 403 reveals nothing.
 */
export function requireMembershipRole(...allowed: MembershipRole[]) {
  return createMiddleware<TenantBindings>(async (c, next) => {
    if (!holdsAnyOf(c.var.membership, allowed))
      return c.json({ message: HttpStatusPhrases.FORBIDDEN }, HttpStatusCodes.FORBIDDEN);

    await next();
  });
}

/**
 * For a clinical act (rule 25): `requireMembershipRole` over clinical roles
 * only, and a practising licence still valid on today's Kenyan date. A
 * licence is valid through its last day.
 *
 * The refusal says why in plain words and who can help (SPEC.md §7.9), with
 * `licence_expired` as its code. Only clinical roles may be listed, so an
 * admin who is also a doctor acts clinically on their licence, never on
 * their admin role.
 */
export function requireClinicalRole(...allowed: ClinicalRole[]) {
  return createMiddleware<TenantBindings>(async (c, next) => {
    const membership = c.var.membership;
    if (!holdsAnyOf(membership, allowed))
      return c.json({ message: HttpStatusPhrases.FORBIDDEN }, HttpStatusCodes.FORBIDDEN);

    const expiresOn = membership.licenceExpiresOn;
    if (!expiresOn || expiresOn < businessDate()) {
      const lapsed = expiresOn
        ? `Your practising licence on record expired on ${printedDate(expiresOn)}.`
        : "No practising licence is on record for you.";
      return c.json(
        { message: `${lapsed} Ask the facility admin to record your current licence.`, code: "licence_expired" },
        HttpStatusCodes.FORBIDDEN,
      );
    }

    await next();
  });
}

function holdsAnyOf(membership: Membership | undefined, allowed: readonly MembershipRole[]): membership is Membership {
  return (membership?.roles ?? []).some(role => allowed.includes(role));
}
