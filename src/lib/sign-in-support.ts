import { and, asc, eq, gte, like, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import db, { withAdvisoryLock } from "@/db";
import { account, session, signInEvents, twoFactor, user, verification } from "@/db/schema";

import type { SignInEvent, SignInFactor } from "./sign-in-log";

import { notify, twoFactorChangeKey } from "./auth";
import { addDays, BUSINESS_TIME_ZONE, startOfBusinessDay } from "./dates";
import { summarizeError } from "./error-summary";
import { logger } from "./logger";
import { recordSignInEvent } from "./sign-in-log";

/**
 * Brixa support's side of sign-in (SPEC.md §2): the sign-in log's export for
 * the quarterly review, and resets of two-step sign-in for someone who has
 * lost both their phone and their backup codes. Called from the superadmin
 * plane alone, on the owner connection: no runtime role may read the log,
 * and a reset writes Better Auth's tables and the log in one transaction.
 */

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

/** Events read at a time for an export: what the API holds of one at once. */
export const EXPORT_PAGE_ROWS = 1_000;

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
 * would take for a formula (`=`, `+`, `-`, `@`, a tab, a return, or the
 * full-width `＝＋－＠`, which some read as the plain ones) is opened with an
 * apostrophe, since a name or a browser string is anyone's to fill.
 */
function cell(value: string | null): string {
  const text = value ?? "";
  const safe = /^[=+\-@\t\r\uFF1D\uFF0B\uFF0D\uFF20]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll("\"", "\"\"")}"`;
}

function csvLine(cells: (string | null)[]): string {
  return `${cells.map(cell).join(",")}\r\n`;
}

/** Events as CSV lines, one an event, for a spreadsheet. */
export function signInEventsCsv(events: ExportedEvent[]): string {
  return events.map(e => csvLine([
    nairobiTime.format(e.at).replace(", ", " "),
    e.event,
    e.factor,
    e.name,
    e.email,
    e.actorEmail,
    e.note,
    e.ipAddress,
    e.userAgent,
  ])).join("");
}

const person = alias(user, "person");
const actor = alias(user, "actor");

/** Where the next page of an export starts: after this event. */
interface ExportCursor {
  /** Its time as Postgres holds it, to the microsecond: a Date keeps only milliseconds. */
  at: string;
  id: string;
}

/** One page of an export: the events in the range after `after`, oldest first. */
function exportPage(start: Date, end: Date, after: ExportCursor | null) {
  return db
    .select({
      at: signInEvents.at,
      exactAt: sql<string>`${signInEvents.at}::text`,
      id: signInEvents.id,
      event: signInEvents.event,
      factor: signInEvents.factor,
      name: person.name,
      email: person.email,
      actorEmail: actor.email,
      note: signInEvents.note,
      ipAddress: signInEvents.ipAddress,
      userAgent: signInEvents.userAgent,
    })
    .from(signInEvents)
    .leftJoin(person, eq(person.id, signInEvents.userId))
    .leftJoin(actor, eq(actor.id, signInEvents.actorId))
    .where(and(
      gte(signInEvents.at, start),
      lt(signInEvents.at, end),
      // The plain bound lets the index on the time start at the page; the pair settles events that share a time.
      after ? sql`${signInEvents.at} >= ${after.at}::timestamptz AND (${signInEvents.at}, ${signInEvents.id}) > (${after.at}::timestamptz, ${after.id}::uuid)` : undefined,
    ))
    .orderBy(asc(signInEvents.at), asc(signInEvents.id))
    .limit(EXPORT_PAGE_ROWS);
}

/**
 * The sign-in log between two Nairobi dates, as CSV, for the quarterly
 * review. Read on the owner connection, as the rest of Brixa support's plane
 * is: no other role may read the log.
 *
 * The export is recorded before anything is read, by whom and for which
 * dates, so none goes out unrecorded; if the record cannot be written, the
 * export is refused. Then it is read a page at a time, each page when the
 * download has taken the last, so the API holds one page of it whatever the
 * range. A page that fails ends the download unfinished, rather than sending
 * a file that looks whole.
 */
export async function exportSignInLog(from: string, to: string, actorId: string): Promise<ReadableStream<Uint8Array>> {
  await recordSignInEvent({ event: "log_exported", actorId, note: `${from} to ${to}` }, db);
  const start = startOfBusinessDay(from);
  const end = startOfBusinessDay(addDays(to, 1));
  const encoder = new TextEncoder();
  let after: ExportCursor | null = null;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(csvLine(EXPORT_COLUMNS)));
    },
    async pull(controller) {
      try {
        const page = await exportPage(start, end, after);
        if (page.length > 0) {
          controller.enqueue(encoder.encode(signInEventsCsv(page)));
          const last = page[page.length - 1];
          after = { at: last.exactAt, id: last.id };
        }
        if (page.length < EXPORT_PAGE_ROWS)
          controller.close();
      }
      catch (err) {
        logger.error({ error: summarizeError(err) }, "Could not finish an export of the sign-in log");
        controller.error(new Error("The export of the sign-in log could not be finished"));
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Resets of two-step sign-in
// ---------------------------------------------------------------------------

export class TwoFactorResetError extends Error {
  constructor(readonly code: "not_found" | "own_account" | "TWO_FACTOR_CHANGE_UNDER_WAY") {
    super({
      not_found: "No account with that email",
      own_account: "Your own two-step sign-in is reset by someone else at Brixa support, not by you.",
      TWO_FACTOR_CHANGE_UNDER_WAY: "A change to this person's two-step sign-in is under way. Try again in a moment.",
    }[code]);
    this.name = "TwoFactorResetError";
  }
}

/**
 * Resets the two-step sign-in of someone who has lost both their phone and
 * their backup codes, once Brixa support has checked who they are. Never a
 * facility admin's act: an account can belong to several facilities. Never
 * one's own.
 *
 * Their authenticator and backup codes go, every session and every sign-in
 * waiting for a code ends, and the reset is logged with support's reason, in
 * one transaction on the owner connection. It also writes the credential's
 * change time, as a new password does, so a code check already under way is
 * refused its session. It runs under the lock the person's own changes take
 * (lib/auth.ts): a setup finishing meanwhile would turn two-step sign-in
 * back on with no authenticator, so while one runs the reset is refused, to
 * be tried again. Signing in next, they are asked to set an authenticator up
 * again. They are told by email, so a reset they did not ask for does not go
 * unnoticed.
 */
export async function resetTwoStepSignIn(input: { email: string; reason: string }, superadminId: string): Promise<{ userId: string }> {
  const [person] = await db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(eq(user.email, input.email.toLowerCase()));
  if (!person)
    throw new TwoFactorResetError("not_found");
  if (person.id === superadminId)
    throw new TwoFactorResetError("own_account");

  const reset = await withAdvisoryLock(twoFactorChangeKey(person.id), () => db.transaction(async (tx) => {
    await tx.delete(twoFactor).where(eq(twoFactor.userId, person.id));
    await tx.update(user).set({ twoFactorEnabled: false }).where(eq(user.id, person.id));
    await tx.delete(session).where(eq(session.userId, person.id));
    await tx.delete(verification).where(and(eq(verification.value, person.id), like(verification.identifier, "2fa-%")));
    // A fence for a sign-in already under way: like a password change, this time refuses it a session (lib/auth.ts).
    await tx.update(account).set({ updatedAt: new Date() }).where(and(eq(account.userId, person.id), eq(account.providerId, "credential")));
    await recordSignInEvent({ event: "two_factor_reset", userId: person.id, actorId: superadminId, note: input.reason }, tx);
  }));
  if (!reset.held)
    throw new TwoFactorResetError("TWO_FACTOR_CHANGE_UNDER_WAY");

  await notify(
    person,
    "two-step sign-in reset notice",
    "Your Brixa HMIS two-step sign-in was reset",
    "Brixa support reset two-step sign-in for your Brixa HMIS account, and every device that was signed in has been signed out. The next time you sign in, you will set up an authenticator app again.",
    "If you did not ask for this, tell your administrator straight away.",
  );
  return { userId: person.id };
}
