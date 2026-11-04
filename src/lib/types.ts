import type { OpenAPIHono, RouteConfig, RouteHandler } from "@hono/zod-openapi";
import type { Schema } from "hono";
import type { PinoLogger } from "hono-pino";

import type { AppDb } from "@/db";
import type { MembershipRole } from "@/db/schema";

import type { Session } from "./auth";

export type { MembershipRole };

/**
 * The PLATFORM role, on the global Better Auth user row.
 *
 * It answers one narrow question: may this login reach the superadmin plane,
 * which onboards and suspends facilities? What a person may do AT a facility
 * lives on their membership there (CLAUDE.md §4), because one person may work
 * at two facilities. Nearly every route wants `requireMembershipRole` instead.
 */
export type UserRole = "user" | "superadmin";

/** The Better Auth user, narrowed with the `role` additional field. */
export type AuthUser = Session["user"] & { role: string };

export interface TenantFacility {
  id: string;
  name: string;
  status: "active" | "suspended";
}

export interface Membership {
  id: string;
  facilityId: string;
  /** Every role this person holds here; a doctor may also be the admin. */
  roles: MembershipRole[];
}

export interface AppBindings {
  Variables: {
    logger: PinoLogger;
    user: AuthUser | null;
    session: Session["session"] | null;
  };
};

/**
 * What a route gets once `withFacility` has run.
 *
 * Separate from `AppBindings` so `db` exists only where a tenant transaction
 * does. Declaring it on the base bindings would make it look available on the
 * superadmin plane too, and that mistake would typecheck.
 */
export interface TenantBindings {
  Variables: AppBindings["Variables"] & {
    facility: TenantFacility;
    membership: Membership;
    /**
     * The tenant-scoped transaction: the only database handle a tenant route
     * may use (CLAUDE.md rule 2, enforced by `db-access.test.ts`).
     */
    db: AppDb;
  };
};

// eslint-disable-next-line ts/no-empty-object-type
export type AppOpenAPI<S extends Schema = {}> = OpenAPIHono<AppBindings, S>;

// eslint-disable-next-line ts/no-empty-object-type
export type TenantOpenAPI<S extends Schema = {}> = OpenAPIHono<TenantBindings, S>;

export type AppRouteHandler<R extends RouteConfig> = RouteHandler<R, AppBindings>;

export type TenantRouteHandler<R extends RouteConfig> = RouteHandler<R, TenantBindings>;
