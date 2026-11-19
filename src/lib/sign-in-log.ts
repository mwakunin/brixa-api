import type { BetterAuthPlugin } from "better-auth";
import type { MiddlewareHandler } from "hono";

import { createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { AsyncLocalStorage } from "node:async_hooks";

import type { AppDb } from "@/db";
import type { AppBindings } from "@/lib/types";

import { authDb } from "@/db";
import { signInEvents } from "@/db/schema";
import { callerAddress } from "@/middlewares/rate-limit";

import { BUSINESS_TIME_ZONE } from "./dates";
import { summarizeError } from "./error-summary";
import { logger } from "./logger";

/**
 * The sign-in log (SPEC.md §2, `sign_in_events`): every sign-in, failed
 * attempt, lock and change to how someone signs in, with where it came from.
 * Regulation 12 asks for a log of login attempts and password changes.
 */

export type SignInEvent = typeof signInEvents.$inferInsert["event"];
export type SignInFactor = NonNullable<typeof signInEvents.$inferInsert["factor"]>;

/** Who is asking, held for the length of their request so an event can say where it came from. */
interface Caller {
  ipAddress: string | null;
  userAgent: string | null;
  /** Set when this request finished setting up an authenticator: its new session is not a sign-in. */
  enrolled: boolean;
  /**
   * Whose code a code route checks: the session's person while setting an
   * authenticator up, else the challenge's. Found before the route runs,
   * since a right code sent at the same moment can spend the challenge.
   */
  codeOwner: string | null;
}

const caller = new AsyncLocalStorage<Caller>();

/** Longer is cut: a user agent is a header anyone can fill. */
const USER_AGENT_MAX = 512;

/** Holds the caller's address and browser for the request (create-app.ts, app-wide). */
export const rememberCaller: MiddlewareHandler<AppBindings> = (c, next) => caller.run({
  ipAddress: callerAddress(c) ?? null,
  userAgent: c.req.header("user-agent")?.slice(0, USER_AGENT_MAX) ?? null,
  enrolled: false,
  codeOwner: null,
}, next);

/** This request set an authenticator up; the session it then issues is the same person carrying on. */
export function markEnrolled(): void {
  const from = caller.getStore();
  if (from)
    from.enrolled = true;
}

/**
 * Writes one event, stamped with the caller's address and browser. On Better
 * Auth's connection by default, which may write the log and not read it; the
 * superadmin plane passes its own.
 */
export async function recordSignInEvent(
  entry: { event: SignInEvent; userId?: string | null; actorId?: string | null; factor?: SignInFactor | null; note?: string | null },
  on: Pick<AppDb, "insert"> = authDb,
): Promise<void> {
  const from = caller.getStore();
  await on.insert(signInEvents).values({
    event: entry.event,
    userId: entry.userId ?? null,
    actorId: entry.actorId ?? null,
    factor: entry.factor ?? null,
    note: entry.note ?? null,
    ipAddress: from?.ipAddress ?? null,
    userAgent: from?.userAgent ?? null,
  });
}

/**
 * Records an event on Better Auth's side, after what it describes has
 * happened. A failure to write it is logged as an error, for alerting, and
 * goes no further: the sign-in, setup or reset it describes is done, and
 * failing the request now would undo none of it and could leave it half
 * finished. Brixa support's export and resets write theirs inside their own
 * transaction instead (`recordSignInEvent`), and fail with it.
 */
export async function noteSignInEvent(entry: Parameters<typeof recordSignInEvent>[0]): Promise<void> {
  try {
    await recordSignInEvent(entry);
  }
  catch (err) {
    logger.error({ error: summarizeError(err), event: entry.event }, "Could not record a sign-in event");
  }
}

/**
 * Runs one of this log's hooks so that nothing in it, a lookup made only
 * for the log or a write, reaches the request it records: a failure is
 * logged as an error, for alerting, and the sign-in answers as it would
 * have without the log.
 */
function quietly(hook: Parameters<typeof createAuthMiddleware>[0]): Parameters<typeof createAuthMiddleware>[0] {
  return async (ctx) => {
    try {
      await hook(ctx);
    }
    catch (err) {
      logger.error({ error: summarizeError(err) }, "Could not record a sign-in event");
    }
  };
}

/** Better Auth's routes this log follows, with the factor each tries. */
const FOLLOWED: Record<string, SignInFactor | null> = {
  "/sign-in/email": "password",
  "/two-factor/verify-totp": "totp",
  "/two-factor/verify-backup-code": "backup_code",
  "/two-factor/generate-backup-codes": null,
  "/change-password": null,
  "/sign-out": null,
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * Records what happened on each followed route, from Better Auth's own
 * answer. Listed after the two-factor plugin (lib/auth.ts), so a password
 * sign-in is seen once the plugin has turned it into a challenge for a code.
 * Events Better Auth's routes do not show here are recorded where they
 * happen: a password reset (`onPasswordReset`), an authenticator set up or
 * turned off (`databaseHooks.user`), a sign-out (`databaseHooks.session`).
 */
export function signInLog(): BetterAuthPlugin {
  return {
    id: "brixa-sign-in-log",
    hooks: {
      before: [{
        matcher: context => context.path === "/two-factor/verify-totp" || context.path === "/two-factor/verify-backup-code",
        handler: createAuthMiddleware(quietly(async (ctx) => {
          const from = caller.getStore();
          if (!from)
            return;
          const current = await getSessionFromCtx(ctx);
          if (current) {
            from.codeOwner = current.user.id;
            return;
          }
          const cookie = ctx.context.createAuthCookie("two_factor");
          const challenge = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
          from.codeOwner = challenge ? (await ctx.context.internalAdapter.findVerificationValue(challenge))?.value ?? null : null;
        })),
      }],
      after: [{
        matcher: context => (context.path ?? "") in FOLLOWED,
        handler: createAuthMiddleware(quietly(async (ctx) => {
          const returned = ctx.context.returned;
          const refused = isAPIError(returned) ? returned : null;
          const factor = FOLLOWED[ctx.path] ?? null;

          if (ctx.path === "/sign-in/email") {
            const email = isRecord(ctx.body) && typeof ctx.body.email === "string" ? ctx.body.email.trim().toLowerCase() : null;
            const named = email ? await ctx.context.internalAdapter.findUserByEmail(email) : null;
            // An address with no account is recorded without it: what was typed may be a password in the wrong box.
            if (refused?.statusCode === 401)
              await noteSignInEvent({ event: "password_failed", userId: named?.user.id, factor });
            else if (!refused && isRecord(returned) && returned.twoFactorRedirect === true)
              await noteSignInEvent({ event: "password_accepted", userId: named?.user.id, factor });
            else if (!refused && ctx.context.newSession)
              await noteSignInEvent({ event: "signed_in", userId: ctx.context.newSession.user.id, factor });
            return;
          }

          if (ctx.path === "/two-factor/verify-totp" || ctx.path === "/two-factor/verify-backup-code") {
            if (!refused) {
              if (ctx.context.newSession && !caller.getStore()?.enrolled)
                await noteSignInEvent({ event: "signed_in", userId: ctx.context.newSession.user.id, factor });
              return;
            }
            // Whose code: found by the before hook, while the challenge was still there to read.
            const userId = caller.getStore()?.codeOwner;
            if (!userId)
              return;
            const code = isRecord(refused.body) ? refused.body.code : undefined;
            if (code === "INVALID_CODE" || code === "INVALID_BACKUP_CODE") {
              await noteSignInEvent({ event: "code_failed", userId, factor });
              // The plugin refuses every try once locked, so this is seen once, at the try that locked it.
              const authenticator = await ctx.context.adapter.findOne<{ lockedUntil: Date | null }>({ model: "twoFactor", where: [{ field: "userId", value: userId }] });
              if (authenticator?.lockedUntil && new Date(authenticator.lockedUntil) > new Date())
                await noteSignInEvent({ event: "locked", userId, factor });
            }
            else if (code === "ACCOUNT_TEMPORARILY_LOCKED") {
              await noteSignInEvent({ event: "refused_locked", userId, factor });
            }
            return;
          }

          const userId = ctx.context.session?.user.id;
          if (refused || !userId)
            return;
          if (ctx.path === "/two-factor/generate-backup-codes")
            await noteSignInEvent({ event: "backup_codes_renewed", userId });
          else if (ctx.path === "/change-password")
            await noteSignInEvent({ event: "password_changed", userId });
        })),
      }],
    },
  };
}

// ---------------------------------------------------------------------------
// The export, for the quarterly review
// ---------------------------------------------------------------------------

export interface ExportedEvent {
  at: Date;
  event: SignInEvent;
  factor: SignInFactor | null;
  name: string | null;
  email: string | null;
  actorEmail: string | null;
  note: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

const EXPORT_COLUMNS = ["at (Nairobi time)", "event", "factor", "name", "email", "by", "note", "ip_address", "user_agent"];

const nairobiTime = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/**
 * One CSV cell. Quoted always, quotes doubled; and a cell a spreadsheet
 * would take for a formula (`=`, `+`, `-`, `@`, a tab, a return) is opened
 * with an apostrophe, since a name or a browser string is anyone's to fill.
 */
function cell(value: string | null): string {
  const text = value ?? "";
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll("\"", "\"\"")}"`;
}

/** The log as CSV, one event a line, oldest first, for a spreadsheet. */
export function signInEventsCsv(events: ExportedEvent[]): string {
  const lines = events.map(e => [
    nairobiTime.format(e.at).replace(", ", " "),
    e.event,
    e.factor,
    e.name,
    e.email,
    e.actorEmail,
    e.note,
    e.ipAddress,
    e.userAgent,
  ].map(cell).join(","));
  return `${[EXPORT_COLUMNS.map(cell).join(","), ...lines].join("\r\n")}\r\n`;
}
