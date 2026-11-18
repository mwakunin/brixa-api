import type { Context, MiddlewareHandler } from "hono";

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
 *
 * Every member of staff signs in with a code from an authenticator app
 * (SPEC.md §2). Someone who has signed in with a password but not yet set one
 * up has a session, and it is good for Better Auth's own routes alone, which
 * are mounted ahead of this: setting the authenticator up, signing out. Here
 * they count as not signed in, so no route can act as them by forgetting to
 * check, and the refusal says what to do (`notSignedIn`).
 */
export const withSession = createMiddleware<AppBindings>(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const ready = session?.user.twoFactorEnabled === true;

  c.set("user", ready ? session.user : null);
  c.set("session", ready ? session.session : null);
  c.set("twoFactorSetupPending", session !== null && !ready);

  await next();
});

/**
 * The answer to a request that needs someone signed in and has nobody: 401,
 * or for a person still to set up their authenticator, 403 with
 * `two_factor_setup_required`, which sends the staff app to its setup screen.
 */
export function notSignedIn<E extends AppBindings>(c: Context<E>): Response {
  if (c.var.twoFactorSetupPending) {
    return c.json(
      { message: "Set up two-step sign-in before you start work.", code: "two_factor_setup_required" },
      HttpStatusCodes.FORBIDDEN,
    );
  }
  return c.json({ message: HttpStatusPhrases.UNAUTHORIZED }, HttpStatusCodes.UNAUTHORIZED);
}

/** Rejects anyone without a valid session. */
export const requireAuth = createMiddleware<AppBindings>(async (c, next) => {
  if (!c.var.user)
    return notSignedIn(c);

  await next();
});

/**
 * Rejects anyone whose PLATFORM role isn't in `allowed`: in practice, the
 * superadmin plane and nothing else. Inside a facility, use
 * `requireMembershipRole`; the global role cannot say "cashier at this
 * hospital".
 */
export function requireRole(...allowed: UserRole[]): MiddlewareHandler<AppBindings> {
  return createMiddleware<AppBindings>(async (c, next) => {
    const user = c.var.user;

    if (!user)
      return notSignedIn(c);

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
export function requireMembershipRole(...allowed: MembershipRole[]): MiddlewareHandler<TenantBindings> {
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
export function requireClinicalRole(...allowed: ClinicalRole[]): MiddlewareHandler<TenantBindings> {
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
