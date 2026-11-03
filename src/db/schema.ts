import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { account, session, user, verification } from "./auth-schema";

// Re-exported so the rest of the app imports every table from one module,
// without caring that identity tables live in a Better-Auth-generated file.
export { account, session, user, verification };

// ---------------------------------------------------------------------------
// Shared column builders
// ---------------------------------------------------------------------------

/** Instants are timestamptz (CLAUDE.md rule 14). */
export function createdAt() {
  return timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
}

// `.$onUpdate` is what makes updated_at move; `.defaultNow()` alone freezes it
// at insert time.
export function updatedAt() {
  return timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
}

/**
 * A foreign key to the Better Auth user table: `text`, not `uuid`, because
 * Better Auth generates its own string ids.
 */
function userRef(name: string) {
  return text(name);
}

/**
 * Values that may reach DDL through `sql.raw` below. Nothing here is user
 * input, and this keeps it that way: no quote, no statement terminator.
 */
function assertDdlSafe(name: string, values: readonly string[]) {
  for (const value of values) {
    if (!/^[a-z0-9_.]+$/.test(value))
      throw new Error(`${name}: unexpected value ${JSON.stringify(value)}`);
  }
}

/**
 * A text column restricted to a known set of values (CLAUDE.md rule 15).
 *
 * `.$type<"a" | "b">()` constrains this codebase and nothing else; a seed or a
 * hand-run correction can put any string in a text column, and the failure is
 * silent: the row stops matching filters. `enum-checks.test.ts` cross-checks
 * every such column against one of these.
 *
 * A CHECK rather than a pgEnum because it changes in one ordinary migration.
 * The values are literals, not bind parameters: DDL cannot take `$1`.
 */
export function oneOf(name: string, column: unknown, values: readonly string[]) {
  assertDdlSafe(name, values);
  const list = values.map(v => `'${v}'`).join(", ");
  return check(name, sql`${column} IN (${sql.raw(list)})`);
}

/**
 * The array form of `oneOf`: every element of a `text[]` column is a known
 * value. An empty array passes `<@`, so "at least one" is a separate CHECK
 * where it matters.
 */
export function allOf(name: string, column: unknown, values: readonly string[]) {
  assertDdlSafe(name, values);
  const list = values.map(v => `'${v}'`).join(", ");
  return check(name, sql`${column} <@ ARRAY[${sql.raw(list)}]::text[]`);
}

// ---------------------------------------------------------------------------
// Tenancy and access (SCHEMA.md §3)
// ---------------------------------------------------------------------------

/**
 * One tenant: one KMHFR facility code, one SHA contract (CLAUDE.md §1).
 *
 * RLS scopes this table by its own primary key, so a tenant reads its own row
 * and nothing else. Creating, listing and suspending facilities happens on the
 * superadmin plane.
 */
export const facilities = pgTable("facilities", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  /** Kenya Master Health Facility List code. */
  kmhfrCode: text().notNull().unique(),
  /** KEPH level, 1 (community) to 6 (national referral). v1 targets level 4. */
  kephLevel: integer().notNull(),
  county: text(),
  /** Set once SHA contracts the facility. */
  shaContractRef: text(),
  status: text().$type<"active" | "suspended">().notNull(),
  createdAt: createdAt(),
}, t => [
  // `suspended` is what stops a facility's requests; a status this table does
  // not recognise is a facility that is neither serving nor stopped.
  oneOf("facilities_status_known", t.status, ["active", "suspended"]),
  check("facilities_keph_level_valid", sql`${t.kephLevel} BETWEEN 1 AND 6`),
]);

/**
 * Who may act at which facility, and as what (CLAUDE.md §4).
 *
 * One row per person per facility, holding a SET of roles: a doctor may also
 * be the facility admin, and a clinical act names one membership (rule 25),
 * not one of several rows for the same person. The cadre and licence columns
 * rule 25 needs arrive with the first clinical act (P3).
 */
export const memberships = pgTable("memberships", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  userId: userRef("user_id").notNull().references(() => user.id),
  roles: text().array().$type<(
    | "facility_admin"
    | "auditor"
    | "records_clerk"
    | "doctor"
    | "clinical_officer"
    | "nurse"
    | "ward_nurse"
    | "lab_tech"
    | "lab_supervisor"
    | "pharmacist"
    | "pharm_tech"
    | "storekeeper"
    | "cashier"
    | "billing_clerk"
    | "claims_officer"
    | "finance_manager"
  )[]>().notNull(),
  isActive: boolean().default(true).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, t => [
  // Also the index for the lookup every tenant request makes.
  unique("memberships_user_id_facility_id_key").on(t.userId, t.facilityId),
  // Composite FK target: a clinical act at one facility cannot name a
  // membership at another (CLAUDE.md §4, layer 4).
  unique("memberships_facility_id_id_key").on(t.facilityId, t.id),
  allOf("memberships_roles_known", t.roles, [
    "facility_admin",
    "auditor",
    "records_clerk",
    "doctor",
    "clinical_officer",
    "nurse",
    "ward_nurse",
    "lab_tech",
    "lab_supervisor",
    "pharmacist",
    "pharm_tech",
    "storekeeper",
    "cashier",
    "billing_clerk",
    "claims_officer",
    "finance_manager",
  ]),
  // A membership with no role passes no guard and fails every one.
  check("memberships_roles_not_empty", sql`cardinality(${t.roles}) > 0`),
]);

/**
 * Who did what, and who viewed what (CLAUDE.md rule 9).
 *
 * Written inside the same transaction as the action it records, so it commits
 * with the change or not at all. Append-only in the database: the runtime role
 * holds INSERT and SELECT, and a trigger refuses UPDATE and DELETE from every
 * role, the owner included.
 */
export const auditLog = pgTable("audit_log", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  /** Null for something the system did with nobody asking. */
  actorId: userRef("actor_id").references(() => user.id),
  /*
   * Written inline, not as a named type: `enum-checks.test.ts` reads this
   * file's syntax tree and can only cross-check an inline union against the
   * `oneOf` below.
   */
  action: text().$type<
    | "facility.created"
    | "invitation.created"
    | "invitation.revoked"
    | "membership.granted"
    | "membership.roles_changed"
    | "membership.revoked"
  >().notNull(),
  /** What it happened to. Not a foreign key: the log outlives what it names. */
  entityType: text().notNull(),
  entityId: uuid(),
  /** One line a human can read without joining anything. */
  summary: text().notNull(),
  detail: jsonb(),
  at: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, t => [
  index().on(t.facilityId, t.at),
  index().on(t.facilityId, t.entityType, t.entityId),
  oneOf("audit_log_action_known", t.action, [
    "facility.created",
    "invitation.created",
    "invitation.revoked",
    "membership.granted",
    "membership.roles_changed",
    "membership.revoked",
  ]),
]);

// ---------------------------------------------------------------------------
// Number series (SCHEMA.md §6)
// ---------------------------------------------------------------------------

/**
 * How a facility numbers one kind of thing: its prefix, its padding, and
 * whether the count restarts each year or each day.
 *
 * Configuration only. The counts live in `number_series_counters`, one row per
 * period, so a prefix change applies going forward without touching a count,
 * and a new year's count starts without copying the configuration. Kinds are
 * added as the modules that issue them land (SCHEMA.md §6.1); patient numbers
 * are registered when a facility is onboarded.
 */
export const numberSeries = pgTable("number_series", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  kind: text().$type<"outpatient" | "inpatient">().notNull(),
  /** Facility-chosen, e.g. `OP`. Applies to numbers issued from now on. */
  prefix: text().notNull(),
  /** Zero-padded width: 4 gives OP0001. A number grows past it, never truncates. */
  padding: integer().default(4).notNull(),
  resetPeriod: text().$type<"never" | "yearly" | "daily">().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, t => [
  unique("number_series_facility_id_kind_key").on(t.facilityId, t.kind),
  unique("number_series_facility_id_id_key").on(t.facilityId, t.id),
  oneOf("number_series_kind_known", t.kind, ["outpatient", "inpatient"]),
  oneOf("number_series_reset_period_known", t.resetPeriod, ["never", "yearly", "daily"]),
  check("number_series_prefix_shape", sql`${t.prefix} ~ '^[A-Za-z0-9/-]{1,12}$'`),
  check("number_series_padding_range", sql`${t.padding} BETWEEN 1 AND 12`),
]);

/**
 * The next value of one series in one period: `all` for a series that never
 * resets, `2026` for a yearly one, `2026-11-03` for a daily one, all computed
 * in Africa/Nairobi (CLAUDE.md rule 26).
 *
 * A counter row rather than a Postgres sequence, because a sequence is not
 * transactional: a rolled-back finalisation would leave a gap in a fiscal
 * series (SCHEMA.md §6). Locking this row serializes issuance per series and
 * period, which is why nothing slow may happen while it is held (rule 18).
 */
export const numberSeriesCounters = pgTable("number_series_counters", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  seriesId: uuid().notNull(),
  periodKey: text().notNull(),
  nextValue: integer().default(1).notNull(),
}, t => [
  unique("number_series_counters_series_id_period_key_key").on(t.seriesId, t.periodKey),
  // Composite, so a counter at one facility cannot drive another's series.
  foreignKey({
    name: "number_series_counters_series_fk",
    columns: [t.facilityId, t.seriesId],
    foreignColumns: [numberSeries.facilityId, numberSeries.id],
  }),
  check("number_series_counters_next_value_positive", sql`${t.nextValue} >= 1`),
  check(
    "number_series_counters_period_key_shape",
    sql`${t.periodKey} ~ '^(all|[0-9]{4}|[0-9]{4}-[0-9]{2}-[0-9]{2})$'`,
  ),
]);

// ---------------------------------------------------------------------------
// Outbox (CLAUDE.md rule 18, §7)
// ---------------------------------------------------------------------------

/**
 * An external call to make, written in the same transaction as the business
 * change that needs it, and made only after that transaction commits.
 *
 * It names an operation and a subject id and nothing else: no addresses, no
 * names, no payload (rule 10). The handler re-reads current state, so a call
 * that is no longer wanted (a revoked invitation) is simply skipped. The
 * subject id carries no foreign key, the exception rule 22 lists.
 */
export const outbox = pgTable("outbox", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  operation: text().$type<"invitation.send">().notNull(),
  subjectId: uuid().notNull(),
  status: text().$type<"pending" | "done" | "failed">().default("pending").notNull(),
  attempts: integer().default(0).notNull(),
  /** Not before this instant: the retry backoff, and a claimed job's lease. */
  availableAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  /** The last failure, for an operator. Never a payload. */
  lastError: text(),
  createdAt: createdAt(),
  completedAt: timestamp({ withTimezone: true }),
}, t => [
  index("outbox_pending_index").on(t.availableAt).where(sql`${t.status} = 'pending'`),
  index().on(t.facilityId, t.operation, t.subjectId),
  oneOf("outbox_operation_known", t.operation, ["invitation.send"]),
  oneOf("outbox_status_known", t.status, ["pending", "done", "failed"]),
  check("outbox_attempts_nonnegative", sql`${t.attempts} >= 0`),
]);

// ---------------------------------------------------------------------------
// Invitations (SPEC.md §2: accounts are invite-only)
// ---------------------------------------------------------------------------

/**
 * An offer of a membership, sent to an email address.
 *
 * Accepting it creates the account if there is none, sets its password, and
 * grants the membership with these roles. The link carries a secret token;
 * only its SHA-256 is stored, issued when the email is sent, so a database
 * reader cannot accept someone else's invitation.
 *
 * Expiry is derived from `expires_at`, never a status (rule 17 in spirit):
 * a pending invitation past its expiry is simply expired.
 */
export const invitations = pgTable("invitations", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  /** Stored lowercased, which is how Better Auth stores `user.email`. */
  email: text().notNull(),
  name: text().notNull(),
  roles: text().array().$type<(
    | "facility_admin"
    | "auditor"
    | "records_clerk"
    | "doctor"
    | "clinical_officer"
    | "nurse"
    | "ward_nurse"
    | "lab_tech"
    | "lab_supervisor"
    | "pharmacist"
    | "pharm_tech"
    | "storekeeper"
    | "cashier"
    | "billing_clerk"
    | "claims_officer"
    | "finance_manager"
  )[]>().notNull(),
  invitedBy: userRef("invited_by").notNull().references(() => user.id),
  status: text().$type<"pending" | "accepted" | "revoked">().default("pending").notNull(),
  tokenHash: text().unique(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  acceptedAt: timestamp({ withTimezone: true }),
  acceptedUserId: userRef("accepted_user_id").references(() => user.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, t => [
  // One open invitation per address per facility.
  uniqueIndex("invitations_one_pending_per_email")
    .on(t.facilityId, t.email)
    .where(sql`${t.status} = 'pending'`),
  unique("invitations_facility_id_id_key").on(t.facilityId, t.id),
  allOf("invitations_roles_known", t.roles, [
    "facility_admin",
    "auditor",
    "records_clerk",
    "doctor",
    "clinical_officer",
    "nurse",
    "ward_nurse",
    "lab_tech",
    "lab_supervisor",
    "pharmacist",
    "pharm_tech",
    "storekeeper",
    "cashier",
    "billing_clerk",
    "claims_officer",
    "finance_manager",
  ]),
  check("invitations_roles_not_empty", sql`cardinality(${t.roles}) > 0`),
  oneOf("invitations_status_known", t.status, ["pending", "accepted", "revoked"]),
  check("invitations_email_lowercase", sql`${t.email} = lower(${t.email})`),
  // Accepted means by someone, at some time; anything else means neither.
  check(
    "invitations_acceptance_matches_status",
    sql`(${t.status} = 'accepted' AND ${t.acceptedAt} IS NOT NULL AND ${t.acceptedUserId} IS NOT NULL)
      OR (${t.status} <> 'accepted' AND ${t.acceptedAt} IS NULL AND ${t.acceptedUserId} IS NULL)`,
  ),
]);

/** What a membership may hold: taken from the column, never restated. */
export type MembershipRole = (typeof memberships.$inferSelect)["roles"][number];

/** What an audit entry may record: taken from the column, never restated. */
export type AuditAction = (typeof auditLog.$inferInsert)["action"];

/**
 * Every table scoped by `facility_id`. `facilities` itself is scoped by its
 * primary key and listed separately in the RLS tests.
 */
export const TENANT_TABLES = [
  "memberships",
  "audit_log",
  "number_series",
  "number_series_counters",
  "outbox",
  "invitations",
] as const;
