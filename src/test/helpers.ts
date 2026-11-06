import type { SQL } from "drizzle-orm";

import { sql } from "drizzle-orm";

import type { MembershipRole, UserRole } from "@/lib/types";

import app from "@/app";
import db, { pool } from "@/db";
import { facilities, memberships, numberSeries, numberSeriesCounters, priceLists } from "@/db/schema";
import { createAccount } from "@/lib/accounts";
import { FACILITY_HEADER } from "@/lib/constants";
import { businessDate } from "@/lib/dates";
import { sentEmails } from "@/lib/email";
import { FISCAL_SERIES } from "@/lib/number-series";
import { redis } from "@/lib/redis";

/**
 * Waits for the shared Redis connection. It connects eagerly, but with its
 * offline queue off (on purpose: the API must not queue behind a reconnect)
 * a command sent before it is ready is refused; under a full suite's load a
 * fresh worker's first reset can get there first.
 */
async function redisReady() {
  if (redis.status === "ready")
    return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Redis not ready (${redis.status})`)), 10_000);
    redis.once("ready", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Wipes every table between tests. Discovered dynamically, so a new table
 * cannot silently start leaking state across tests.
 */
export async function resetDb() {
  // Captured mail and rate-limit counters are per-test state like anything else.
  sentEmails.length = 0;
  await redisReady();
  const keys = await redis.keys("rl:*");
  if (keys.length > 0)
    await redis.del(...keys);

  const { rows } = await pool.query<{ tablename: string }>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations'
  `);

  if (rows.length === 0)
    return;

  const tables = rows.map(r => `"${r.tablename}"`).join(", ");
  await pool.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}

let ipCounter = 0;

/**
 * A fresh client address. `.env.test` trusts one proxy hop, so this is the
 * address the rate limiter sees; giving each harness request its own keeps
 * one test's sign-ins from spending another's budget.
 */
export function nextIp() {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

export async function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": nextIp(), ...headers },
    body: JSON.stringify(body),
  });
}

export interface TestUser {
  id: string;
  email: string;
  /** Ready-to-spread request headers carrying the session cookie. */
  headers: { cookie: string };
}

/** Keeps only the name=value pairs; a request Cookie header has no attributes. */
function cookieFrom(setCookie: string) {
  return setCookie
    .split(/,(?=\s*[^;=\s]+=)/)
    .map(c => c.split(";")[0].trim())
    .join("; ");
}

let emailCounter = 0;

/** A unique address, so tests never collide on user.email's unique index. */
export function nextEmail() {
  emailCounter += 1;
  return `person${emailCounter}@example.test`;
}

export const TEST_PASSWORD = "correct-horse-battery";

/** An account made on the server, as an invitation makes one (lib/accounts.ts). */
export async function createTestAccount(email: string, name = "Test User", role: UserRole = "user") {
  return createAccount({ email, name, password: TEST_PASSWORD, role });
}

/** Signs in through the real endpoint and returns the session cookie headers. */
export async function signIn(email: string, password = TEST_PASSWORD): Promise<{ cookie: string }> {
  const res = await postJson("/api/auth/sign-in/email", { email, password });
  if (!res.ok)
    throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);

  const setCookie = res.headers.get("set-cookie");
  if (!setCookie)
    throw new Error("sign-in returned no session cookie");

  return { cookie: cookieFrom(setCookie) };
}

/**
 * A new account, signed in through the real sign-in endpoint rather than a
 * forged session row, so the tests exercise the code path production does.
 */
export async function signedInUser(
  options: { email?: string; role?: UserRole; name?: string } = {},
): Promise<TestUser> {
  const email = options.email ?? nextEmail();
  const created = await createTestAccount(email, options.name, options.role);

  return { id: created.id, email, headers: await signIn(email) };
}

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

let facilityCounter = 0;

/**
 * A facility, on the OWNER connection. Test setup legitimately works across
 * tenants: an isolation test needs two facilities before either can be shown
 * to be invisible to the other.
 */
export async function makeFacility(overrides: {
  name?: string;
  status?: "active" | "suspended";
} = {}) {
  facilityCounter += 1;

  const [facility] = await db
    .insert(facilities)
    .values({
      name: overrides.name ?? `Test Hospital ${facilityCounter}`,
      kmhfrCode: `T${String(facilityCounter).padStart(5, "0")}`,
      kephLevel: 4,
      status: overrides.status ?? "active",
    })
    .returning();

  return facility;
}

/**
 * A facility as onboarding leaves it: the OP, IP and admission series
 * (`OP0001`, `IP0001`, `ADM-2026-0001`), the fiscal series
 * (`INV-2026-000001`) and a cash price list.
 */
export async function makeOnboardedFacility(overrides: { name?: string } = {}) {
  const facility = await makeFacility(overrides);
  const series: (typeof numberSeries.$inferInsert & { resetPeriod: "never" | "yearly" })[] = [
    { facilityId: facility.id, kind: "outpatient", prefix: "OP", resetPeriod: "never", padding: 4 },
    { facilityId: facility.id, kind: "inpatient", prefix: "IP", resetPeriod: "never", padding: 4 },
    { facilityId: facility.id, kind: "admission", prefix: "ADM-", resetPeriod: "yearly", padding: 4 },
    ...FISCAL_SERIES.map(([kind, prefix]) => ({ facilityId: facility.id, kind, prefix, resetPeriod: "yearly" as const, padding: 6 })),
  ];

  await db.transaction(async (tx) => {
    for (const s of series) {
      const [row] = await tx.insert(numberSeries).values(s).returning({ id: numberSeries.id });
      await tx.insert(numberSeriesCounters).values({ facilityId: facility.id, seriesId: row.id, periodKey: s.resetPeriod === "yearly" ? businessDate().slice(0, 4) : "all" });
    }
    await tx.insert(priceLists).values({ facilityId: facility.id, name: "Cash", kind: "cash" });
  });

  return facility;
}

/** Gives `userId` a membership at `facilityId` holding `roles`. */
export async function addMembership(
  userId: string,
  facilityId: string,
  roles: MembershipRole[],
  options: { isActive?: boolean } = {},
) {
  const [row] = await db
    .insert(memberships)
    .values({ userId, facilityId, roles, isActive: options.isActive ?? true })
    .returning();

  return row;
}

/** A signed-in person holding `roles` at a facility: most tests' setup. */
export async function signedInUserAt(
  facilityId: string,
  roles: MembershipRole[],
): Promise<TestUser> {
  const person = await signedInUser();
  await addMembership(person.id, facilityId, roles);
  return person;
}

/**
 * Request headers naming a facility, carrying a signed-in session. A test that
 * forgets the facility header is testing the 400 path rather than what it
 * meant to.
 */
export function facilityHeaders(facilityId: string, person?: TestUser) {
  return {
    [FACILITY_HEADER]: facilityId,
    ...(person ? person.headers : {}),
  };
}

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

/** The Postgres backend behind a transaction, so lock tests can name their holder. */
export async function backendPid(
  tx: { execute: (query: SQL) => Promise<{ rows: Record<string, unknown>[] }> },
): Promise<number> {
  const { rows } = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
  return Number(rows[0].pid);
}

/**
 * Waits until Postgres reports `count` backends queued behind `holderPid`. A
 * fixed sleep only guesses that contention happened; this asks the database.
 *
 * Queued means blocked by the holder, or by another backend that is itself
 * queued: of two backends waiting for one row lock, Postgres reports the
 * second as blocked by the first, not by the holder.
 */
export async function waitForBlockedBackend(
  holderPid: number,
  timeoutMs = 2500,
  count = 1,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ n: number }>(
      `WITH RECURSIVE waiting AS (
         SELECT pid FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND state = 'active'
       ),
       queued(pid) AS (
         SELECT pid FROM waiting WHERE $1 = ANY(pg_blocking_pids(pid))
         UNION
         SELECT w.pid FROM waiting w JOIN queued q ON q.pid = ANY(pg_blocking_pids(w.pid))
       )
       SELECT count(*)::int AS n FROM queued`,
      [holderPid],
    );
    if (rows[0].n >= count)
      return true;

    await new Promise(resolve => setTimeout(resolve, 20));
  }

  return false;
}
