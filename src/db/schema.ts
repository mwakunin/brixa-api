import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type { DocumentContent } from "@/lib/document-content";

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
 * A number as an M-Pesa payer might type it, made comparable: uppercased,
 * spaces and separators dropped (`inv-2026 000123` reads as `INV2026000123`).
 * One definition for the matching queries (`lib/mpesa.ts`) and the indexes
 * that serve them: Postgres uses an expression index only for the very same
 * expression.
 */
export function normalisedNumber(column: unknown) {
  return sql`upper(regexp_replace(${column}, '[\\s/\\-_.]', '', 'g'))`;
}

/**
 * An STK callback's checkout id, read from its stored payload. One
 * definition for the early-callback lookups (`lib/mpesa-stk.ts`) and the
 * indexes that serve them, as with `normalisedNumber`.
 */
export function stkCheckoutId(column: unknown) {
  return sql`(${column} #>> '{Body,stkCallback,CheckoutRequestID}')`;
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
    | "document.issued"
    | "document.voided"
    | "document.viewed"
    | "document.verified"
    | "patient.registered"
    | "patient.updated"
    | "patient.identifier_added"
    | "patient.viewed"
    | "patient.searched"
    | "encounter.opened"
    | "encounter.closed"
    | "encounter.cancelled"
    | "encounter.viewed"
    | "patient.admitted"
    | "patient.transferred"
    | "patient.discharged"
    | "ward.created"
    | "bed.created"
    | "billable_item.created"
    | "price_change.requested"
    | "price_change.approved"
    | "price_change.rejected"
    | "price_change.withdrawn"
    | "ward.bed_day_item_set"
    | "charge.posted"
    | "charge.accrued"
    | "charge.cancelled"
    | "invoice.drafted"
    | "invoice.finalised"
    | "invoice.voided"
    | "invoice.viewed"
    | "adjustment.requested"
    | "adjustment.approved"
    | "adjustment.rejected"
    | "adjustment.withdrawn"
    | "adjustment.listed"
    | "shift.opened"
    | "shift.closed"
    | "payment.recorded"
    | "payment.reversed"
    | "allocation.recorded"
    | "allocation.reversed"
    | "account.viewed"
    | "payment.viewed"
    | "refund.requested"
    | "refund.approved"
    | "refund.rejected"
    | "refund.withdrawn"
    | "refund.paid"
    | "refund.reversed"
    | "refund.listed"
    | "mpesa.settings_changed"
    | "mpesa.received"
    | "mpesa.assigned"
    | "mpesa.rejected"
    | "mpesa.listed"
    | "mpesa.stk_requested"
    | "adjustment.reversal_requested"
    | "adjustment.reversed"
    | "adjustment.reversal_rejected"
    | "adjustment.reversal_withdrawn"
    | "adjustment.reversals_listed"
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
    "document.issued",
    "document.voided",
    "document.viewed",
    "document.verified",
    "patient.registered",
    "patient.updated",
    "patient.identifier_added",
    "patient.viewed",
    "patient.searched",
    "encounter.opened",
    "encounter.closed",
    "encounter.cancelled",
    "encounter.viewed",
    "patient.admitted",
    "patient.transferred",
    "patient.discharged",
    "ward.created",
    "bed.created",
    "billable_item.created",
    "price_change.requested",
    "price_change.approved",
    "price_change.rejected",
    "price_change.withdrawn",
    "ward.bed_day_item_set",
    "charge.posted",
    "charge.accrued",
    "charge.cancelled",
    "invoice.drafted",
    "invoice.finalised",
    "invoice.voided",
    "invoice.viewed",
    "adjustment.requested",
    "adjustment.approved",
    "adjustment.rejected",
    "adjustment.withdrawn",
    "adjustment.listed",
    "shift.opened",
    "shift.closed",
    "payment.recorded",
    "payment.reversed",
    "allocation.recorded",
    "allocation.reversed",
    "account.viewed",
    "payment.viewed",
    "refund.requested",
    "refund.approved",
    "refund.rejected",
    "refund.withdrawn",
    "refund.paid",
    "refund.reversed",
    "refund.listed",
    "mpesa.settings_changed",
    "mpesa.received",
    "mpesa.assigned",
    "mpesa.rejected",
    "mpesa.listed",
    "mpesa.stk_requested",
    "adjustment.reversal_requested",
    "adjustment.reversed",
    "adjustment.reversal_rejected",
    "adjustment.reversal_withdrawn",
    "adjustment.reversals_listed",
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
  kind: text().$type<"outpatient" | "inpatient" | "admission" | "receipt" | "invoice" | "credit_note" | "refund">().notNull(),
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
  oneOf("number_series_kind_known", t.kind, ["outpatient", "inpatient", "admission", "receipt", "invoice", "credit_note", "refund"]),
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
  operation: text().$type<"invitation.send" | "mpesa.register_urls" | "mpesa.stk_push">().notNull(),
  subjectId: uuid().notNull(),
  status: text().$type<"pending" | "done" | "skipped" | "failed">().default("pending").notNull(),
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
  oneOf("outbox_operation_known", t.operation, ["invitation.send", "mpesa.register_urls", "mpesa.stk_push"]),
  oneOf("outbox_status_known", t.status, ["pending", "done", "skipped", "failed"]),
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

// ---------------------------------------------------------------------------
// Printed documents (SCHEMA.md §6.2)
// ---------------------------------------------------------------------------

/**
 * Every printed document the facility issues: its number, the code its QR
 * carries, and exactly what it says.
 *
 * Issued in the transaction that finalises whatever it documents, which is
 * also the one that takes its number (rule 20). From then on it is frozen
 * (rule 19): a trigger refuses any change except voiding it once, and refuses
 * deletion from every role, so a voided document keeps its number and the
 * series has no gaps. Modules point at a document (a receipt row at its
 * document), never the other way, so no polymorphic reference is needed
 * (rule 22).
 */
export const documents = pgTable("documents", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  kind: text().$type<"receipt" | "invoice" | "credit_note" | "refund">().notNull(),
  /** From this facility's number series of the same kind. */
  number: text().notNull(),
  /**
   * The QR's payload and the public verify endpoint's only credential: 160
   * random bits, base64url. Unguessable because that endpoint has no session.
   */
  verificationCode: text().notNull().unique(),
  /** What is printed, and all that the PDF is rendered from (rule 7). */
  content: jsonb().$type<DocumentContent>().notNull(),
  issuedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  /** The membership that issued it; null when the system did. */
  issuedBy: uuid(),
  voidedAt: timestamp({ withTimezone: true }),
  /** Kept with the document, never shown on the public verify page. */
  voidReason: text(),
}, t => [
  unique("documents_facility_id_id_key").on(t.facilityId, t.id),
  unique("documents_facility_id_kind_number_key").on(t.facilityId, t.kind, t.number),
  // M-Pesa matching: an invoice number as a payer typed it.
  index("documents_normalised_invoice_number_index").on(t.facilityId, normalisedNumber(t.number)).where(sql`${t.kind} = 'invoice'`),
  foreignKey({
    name: "documents_issued_by_fk",
    columns: [t.facilityId, t.issuedBy],
    foreignColumns: [memberships.facilityId, memberships.id],
  }),
  oneOf("documents_kind_known", t.kind, ["receipt", "invoice", "credit_note", "refund"]),
  // 20 bytes of base64url: a shorter code typed in by hand would be guessable.
  check("documents_verification_code_shape", sql`${t.verificationCode} ~ '^[A-Za-z0-9_-]{27}$'`),
  // Voided means at some time, for a stated reason; otherwise neither. The
  // explicit IS NOT NULL matters: on a NULL reason `length(...) > 0` is NULL,
  // and a CHECK passes on NULL.
  check(
    "documents_void_has_reason",
    sql`(${t.voidedAt} IS NULL AND ${t.voidReason} IS NULL)
      OR (${t.voidedAt} IS NOT NULL AND ${t.voidReason} IS NOT NULL AND length(btrim(${t.voidReason})) > 0)`,
  ),
]);

// ---------------------------------------------------------------------------
// Patients (SCHEMA.md §5)
// ---------------------------------------------------------------------------

/**
 * A person this facility treats. One register per facility (SPEC.md D6).
 *
 * Registration asks for names, sex, a date of birth (or an age, stored as an
 * estimated date), a phone number and an identity document. A phone or a
 * document may be missing only with a stated reason, so an unconscious
 * patient can still be registered and treated, and the record shows what is
 * still to be collected. An unidentified patient carries placeholder names
 * and may have no recorded sex until identified.
 */
export const patients = pgTable("patients", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  // Kenyan names do not split reliably into a fixed given/surname order.
  givenName: text().notNull(),
  middleNames: text(),
  familyName: text().notNull(),
  dateOfBirth: date({ mode: "string" }).notNull(),
  /** True when the date was worked out from a stated age. */
  dobIsEstimated: boolean().default(false).notNull(),
  sex: text().$type<"male" | "female" | "intersex">(),
  /** E.164 (rule 13). */
  phone: text(),
  noPhoneReason: text().$type<"no_phone" | "unidentified">(),
  noIdReason: text().$type<"none_held" | "not_carried" | "unidentified">(),
  /** Brought in unable to say who they are; names are placeholders until identified. */
  unidentified: boolean().default(false).notNull(),
  registeredAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  /** The membership that registered them. */
  registeredBy: uuid().notNull(),
  updatedAt: updatedAt(),
}, t => [
  unique("patients_facility_id_id_key").on(t.facilityId, t.id),
  foreignKey({
    name: "patients_registered_by_fk",
    columns: [t.facilityId, t.registeredBy],
    foreignColumns: [memberships.facilityId, memberships.id],
  }),
  index("patients_family_name_index").on(t.facilityId, sql`lower(${t.familyName})`),
  index("patients_phone_index").on(t.facilityId, t.phone),
  oneOf("patients_sex_known", t.sex, ["male", "female", "intersex"]),
  oneOf("patients_no_phone_reason_known", t.noPhoneReason, ["no_phone", "unidentified"]),
  oneOf("patients_no_id_reason_known", t.noIdReason, ["none_held", "not_carried", "unidentified"]),
  check("patients_names_present", sql`length(btrim(${t.givenName})) > 0 AND length(btrim(${t.familyName})) > 0`),
  check("patients_phone_e164", sql`${t.phone} IS NULL OR ${t.phone} ~ '^\\+[1-9][0-9]{7,14}$'`),
  // A phone, or the reason there is none: never neither, never both.
  check("patients_phone_or_reason", sql`(${t.phone} IS NULL) = (${t.noPhoneReason} IS NOT NULL)`),
  check("patients_sex_unless_unidentified", sql`${t.sex} IS NOT NULL OR ${t.unidentified}`),
  check(
    "patients_unidentified_reasons",
    sql`(${t.noPhoneReason} IS DISTINCT FROM 'unidentified' AND ${t.noIdReason} IS DISTINCT FROM 'unidentified') OR ${t.unidentified}`,
  ),
]);

/**
 * The numbers a patient is known by here: the OP number from registration,
 * the IP number from their first admission (P2, encounters). Frozen text,
 * never rebuilt from the current prefix (SCHEMA.md §6).
 */
export const patientNumbers = pgTable("patient_numbers", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  patientId: uuid().notNull(),
  kind: text().$type<"outpatient" | "inpatient">().notNull(),
  number: text().notNull(),
  issuedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, t => [
  unique("patient_numbers_facility_id_number_key").on(t.facilityId, t.number),
  // M-Pesa matching: an OP or IP number as a payer typed it.
  index("patient_numbers_normalised_number_index").on(t.facilityId, normalisedNumber(t.number)),
  // At most one OP and one IP number per patient.
  unique("patient_numbers_patient_id_kind_key").on(t.patientId, t.kind),
  index("patient_numbers_number_search_index").on(t.facilityId, sql`upper(${t.number})`),
  foreignKey({
    name: "patient_numbers_patient_fk",
    columns: [t.facilityId, t.patientId],
    foreignColumns: [patients.facilityId, patients.id],
  }),
  oneOf("patient_numbers_kind_known", t.kind, ["outpatient", "inpatient"]),
]);

/**
 * Identity documents and registry numbers. Stored uppercase without spaces,
 * so a search matches however the number was typed. Not unique across
 * patients: a mistyped number must not block the person it really belongs
 * to, so a match is a warning at registration instead.
 */
export const patientIdentifiers = pgTable("patient_identifiers", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  patientId: uuid().notNull(),
  type: text().$type<
    | "national_id"
    | "passport"
    | "birth_certificate"
    | "alien_id"
    | "refugee_id"
    | "sha_number"
    | "client_registry_id"
    | "other"
  >().notNull(),
  value: text().notNull(),
  addedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  addedBy: uuid().notNull(),
}, t => [
  index("patient_identifiers_lookup_index").on(t.facilityId, t.value),
  unique("patient_identifiers_patient_id_type_value_key").on(t.patientId, t.type, t.value),
  foreignKey({
    name: "patient_identifiers_patient_fk",
    columns: [t.facilityId, t.patientId],
    foreignColumns: [patients.facilityId, patients.id],
  }),
  foreignKey({
    name: "patient_identifiers_added_by_fk",
    columns: [t.facilityId, t.addedBy],
    foreignColumns: [memberships.facilityId, memberships.id],
  }),
  oneOf("patient_identifiers_type_known", t.type, [
    "national_id",
    "passport",
    "birth_certificate",
    "alien_id",
    "refugee_id",
    "sha_number",
    "client_registry_id",
    "other",
  ]),
  check("patient_identifiers_value_shape", sql`${t.value} ~ '^[A-Z0-9/-]{1,40}$'`),
]);

// ---------------------------------------------------------------------------
// Billable items and prices (SCHEMA.md §7.2)
// ---------------------------------------------------------------------------

/**
 * What the facility charges for: a consultation, a bed-day, a test, a drug.
 * The catalogue holds identity only; what it costs lives in price lists.
 */
export const billableItems = pgTable("billable_items", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  /** The facility's own code, printed on bills and used in claims (rule 8). */
  code: text().notNull(),
  name: text().notNull(),
  category: text().$type<
    "consultation" | "bed_day" | "lab" | "imaging" | "procedure" | "drug" | "consumable" | "service" | "other"
  >().notNull(),
  isActive: boolean().default(true).notNull(),
  createdAt: createdAt(),
}, t => [
  unique("billable_items_facility_id_id_key").on(t.facilityId, t.id),
  unique("billable_items_facility_id_code_key").on(t.facilityId, t.code),
  oneOf("billable_items_category_known", t.category, [
    "consultation",
    "bed_day",
    "lab",
    "imaging",
    "procedure",
    "drug",
    "consumable",
    "service",
    "other",
  ]),
  check("billable_items_code_shape", sql`${t.code} ~ '^[A-Z0-9][A-Z0-9./-]{0,23}$'`),
  check("billable_items_name_present", sql`length(btrim(${t.name})) > 0`),
]);

/**
 * A set of prices. Each facility has one cash list, which prices the patient
 * account; payers' lists arrive in P7. An item absent from a list is not
 * covered by it, never priced from another (rule 21).
 */
export const priceLists = pgTable("price_lists", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  name: text().notNull(),
  kind: text().$type<"cash">().notNull(),
  createdAt: createdAt(),
}, t => [
  unique("price_lists_facility_id_id_key").on(t.facilityId, t.id),
  uniqueIndex("price_lists_one_cash_list").on(t.facilityId).where(sql`${t.kind} = 'cash'`),
  oneOf("price_lists_kind_known", t.kind, ["cash"]),
]);

/**
 * A request to change prices, approved by a second person before it applies
 * (rule 24). One request may carry many lines, so loading a facility's
 * whole tariff is one approval. `status` is its lifecycle.
 */
export const priceChanges = pgTable("price_changes", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  priceListId: uuid().notNull(),
  status: text().$type<"pending" | "approved" | "rejected" | "withdrawn">().default("pending").notNull(),
  /** The Kenyan day the new prices take effect. */
  effectiveFrom: date({ mode: "string" }).notNull(),
  reason: text().notNull(),
  requestedBy: uuid().notNull(),
  requestedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  decidedBy: uuid(),
  decidedAt: timestamp({ withTimezone: true }),
}, t => [
  unique("price_changes_facility_id_id_key").on(t.facilityId, t.id),
  foreignKey({ name: "price_changes_price_list_fk", columns: [t.facilityId, t.priceListId], foreignColumns: [priceLists.facilityId, priceLists.id] }),
  foreignKey({ name: "price_changes_requested_by_fk", columns: [t.facilityId, t.requestedBy], foreignColumns: [memberships.facilityId, memberships.id] }),
  foreignKey({ name: "price_changes_decided_by_fk", columns: [t.facilityId, t.decidedBy], foreignColumns: [memberships.facilityId, memberships.id] }),
  oneOf("price_changes_status_known", t.status, ["pending", "approved", "rejected", "withdrawn"]),
  check("price_changes_reason_present", sql`length(btrim(${t.reason})) > 0`),
  // Approved or rejected by someone else; withdrawn only by the requester.
  check(
    "price_changes_decision",
    sql`(${t.status} = 'pending' AND ${t.decidedBy} IS NULL AND ${t.decidedAt} IS NULL)
      OR (${t.status} IN ('approved', 'rejected') AND ${t.decidedBy} IS NOT NULL AND ${t.decidedAt} IS NOT NULL
          AND ${t.decidedBy} <> ${t.requestedBy})
      OR (${t.status} = 'withdrawn' AND ${t.decidedBy} IS NOT NULL AND ${t.decidedBy} = ${t.requestedBy} AND ${t.decidedAt} IS NOT NULL)`,
  ),
]);

export const priceChangeLines = pgTable("price_change_lines", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  priceChangeId: uuid().notNull(),
  billableItemId: uuid().notNull(),
  /** Cents, which allows fractional shillings in a unit price (SPEC.md D2). */
  unitPriceCents: integer().notNull(),
}, t => [
  unique("price_change_lines_change_item_key").on(t.priceChangeId, t.billableItemId),
  foreignKey({ name: "price_change_lines_change_fk", columns: [t.facilityId, t.priceChangeId], foreignColumns: [priceChanges.facilityId, priceChanges.id] }),
  foreignKey({ name: "price_change_lines_item_fk", columns: [t.facilityId, t.billableItemId], foreignColumns: [billableItems.facilityId, billableItems.id] }),
  check("price_change_lines_price_nonnegative", sql`${t.unitPriceCents} >= 0`),
]);

/**
 * One item's price on one list, from `valid_from` until `valid_to`
 * (exclusive; open-ended when null). Written only by an approved price
 * change. Migration 0012 adds the exclusion constraint that forbids two
 * overlapping prices for one item on one list. A superseded price only has
 * `valid_to` set; a price replaced before it took effect ends on its own
 * start day, so it never applied.
 */
export const priceListItems = pgTable("price_list_items", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  priceListId: uuid().notNull(),
  billableItemId: uuid().notNull(),
  unitPriceCents: integer().notNull(),
  validFrom: date({ mode: "string" }).notNull(),
  validTo: date({ mode: "string" }),
  /** The approved change that set this price. */
  priceChangeId: uuid().notNull(),
}, t => [
  unique("price_list_items_facility_id_id_key").on(t.facilityId, t.id),
  foreignKey({ name: "price_list_items_list_fk", columns: [t.facilityId, t.priceListId], foreignColumns: [priceLists.facilityId, priceLists.id] }),
  foreignKey({ name: "price_list_items_item_fk", columns: [t.facilityId, t.billableItemId], foreignColumns: [billableItems.facilityId, billableItems.id] }),
  foreignKey({ name: "price_list_items_change_fk", columns: [t.facilityId, t.priceChangeId], foreignColumns: [priceChanges.facilityId, priceChanges.id] }),
  index("price_list_items_lookup_index").on(t.priceListId, t.billableItemId, t.validFrom),
  check("price_list_items_price_nonnegative", sql`${t.unitPriceCents} >= 0`),
  check("price_list_items_valid_range", sql`${t.validTo} IS NULL OR ${t.validTo} >= ${t.validFrom}`),
]);

// ---------------------------------------------------------------------------
// Encounters, wards and admissions (SCHEMA.md §8)
// ---------------------------------------------------------------------------

/** A ward. Its beds are where a patient's bed-days are counted (P2, charges). */
export const wards = pgTable("wards", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  name: text().notNull(),
  /** What a night in this ward is charged as; its price comes from the price list. */
  bedDayItemId: uuid(),
  isActive: boolean().default(true).notNull(),
  createdAt: createdAt(),
}, t => [
  unique("wards_facility_id_id_key").on(t.facilityId, t.id),
  unique("wards_facility_id_name_key").on(t.facilityId, t.name),
  foreignKey({
    name: "wards_bed_day_item_fk",
    columns: [t.facilityId, t.bedDayItemId],
    foreignColumns: [billableItems.facilityId, billableItems.id],
  }),
  check("wards_name_present", sql`length(btrim(${t.name})) > 0`),
]);

export const beds = pgTable("beds", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  wardId: uuid().notNull(),
  /** As painted on the bed, e.g. `B12`. */
  label: text().notNull(),
  isActive: boolean().default(true).notNull(),
  createdAt: createdAt(),
}, t => [
  unique("beds_facility_id_id_key").on(t.facilityId, t.id),
  unique("beds_ward_id_label_key").on(t.wardId, t.label),
  foreignKey({ name: "beds_ward_fk", columns: [t.facilityId, t.wardId], foreignColumns: [wards.facilityId, wards.id] }),
  check("beds_label_present", sql`length(btrim(${t.label})) > 0`),
]);

/**
 * A patient's contact with the facility: an outpatient visit, an emergency
 * attendance, or an admission (`ipd`). Charges, notes and orders all hang off
 * one (SCHEMA.md §7.2, §8).
 *
 * `status` is lifecycle only (rule 17): open while care is under way, closed
 * when it ends, cancelled if it was opened by mistake. One open encounter of
 * each kind per patient at a time.
 */
export const encounters = pgTable("encounters", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  patientId: uuid().notNull(),
  kind: text().$type<"opd" | "emergency" | "ipd">().notNull(),
  status: text().$type<"open" | "closed" | "cancelled">().default("open").notNull(),
  startedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  endedAt: timestamp({ withTimezone: true }),
  openedBy: uuid().notNull(),
  /** Who closed or cancelled it. */
  closedBy: uuid(),
  cancelReason: text(),
  /** The visit this one came from, e.g. the emergency attendance an admission followed. */
  parentEncounterId: uuid(),
  updatedAt: updatedAt(),
}, t => [
  unique("encounters_facility_id_id_key").on(t.facilityId, t.id),
  foreignKey({ name: "encounters_patient_fk", columns: [t.facilityId, t.patientId], foreignColumns: [patients.facilityId, patients.id] }),
  foreignKey({ name: "encounters_opened_by_fk", columns: [t.facilityId, t.openedBy], foreignColumns: [memberships.facilityId, memberships.id] }),
  foreignKey({ name: "encounters_closed_by_fk", columns: [t.facilityId, t.closedBy], foreignColumns: [memberships.facilityId, memberships.id] }),
  foreignKey({
    name: "encounters_parent_fk",
    columns: [t.facilityId, t.parentEncounterId],
    foreignColumns: [t.facilityId, t.id],
  }),
  uniqueIndex("encounters_one_open_per_patient_and_kind")
    .on(t.facilityId, t.patientId, t.kind)
    .where(sql`${t.status} = 'open'`),
  index("encounters_patient_index").on(t.facilityId, t.patientId, t.startedAt),
  oneOf("encounters_kind_known", t.kind, ["opd", "emergency", "ipd"]),
  oneOf("encounters_status_known", t.status, ["open", "closed", "cancelled"]),
  check(
    "encounters_lifecycle",
    sql`(${t.status} = 'open' AND ${t.endedAt} IS NULL AND ${t.closedBy} IS NULL AND ${t.cancelReason} IS NULL)
      OR (${t.status} = 'closed' AND ${t.endedAt} IS NOT NULL AND ${t.closedBy} IS NOT NULL AND ${t.cancelReason} IS NULL)
      OR (${t.status} = 'cancelled' AND ${t.endedAt} IS NOT NULL AND ${t.closedBy} IS NOT NULL
          AND ${t.cancelReason} IS NOT NULL AND length(btrim(${t.cancelReason})) > 0)`,
  ),
  check("encounters_ends_after_start", sql`${t.endedAt} IS NULL OR ${t.endedAt} >= ${t.startedAt}`),
]);

/**
 * An inpatient stay: one per `ipd` encounter, carrying its admission number
 * (yearly, e.g. `ADM-2026-0153`). Discharge closes the encounter and ends the
 * bed stay; the clinical discharge summary is P5.
 */
export const admissions = pgTable("admissions", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  encounterId: uuid().notNull(),
  admissionNumber: text().notNull(),
  admittedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  admittedBy: uuid().notNull(),
  dischargedAt: timestamp({ withTimezone: true }),
  dischargedBy: uuid(),
  /** How the stay ended, for MOH 717 and the ward's own count. */
  dischargeDisposition: text().$type<"home" | "referred" | "died" | "absconded" | "against_advice">(),
}, t => [
  unique("admissions_facility_id_id_key").on(t.facilityId, t.id),
  unique("admissions_encounter_id_key").on(t.encounterId),
  unique("admissions_facility_id_admission_number_key").on(t.facilityId, t.admissionNumber),
  // M-Pesa matching: an admission number as a payer typed it.
  index("admissions_normalised_number_index").on(t.facilityId, normalisedNumber(t.admissionNumber)),
  foreignKey({ name: "admissions_encounter_fk", columns: [t.facilityId, t.encounterId], foreignColumns: [encounters.facilityId, encounters.id] }),
  foreignKey({ name: "admissions_admitted_by_fk", columns: [t.facilityId, t.admittedBy], foreignColumns: [memberships.facilityId, memberships.id] }),
  foreignKey({ name: "admissions_discharged_by_fk", columns: [t.facilityId, t.dischargedBy], foreignColumns: [memberships.facilityId, memberships.id] }),
  oneOf("admissions_discharge_disposition_known", t.dischargeDisposition, ["home", "referred", "died", "absconded", "against_advice"]),
  check(
    "admissions_discharge_complete",
    sql`(${t.dischargedAt} IS NULL AND ${t.dischargedBy} IS NULL AND ${t.dischargeDisposition} IS NULL)
      OR (${t.dischargedAt} IS NOT NULL AND ${t.dischargedBy} IS NOT NULL AND ${t.dischargeDisposition} IS NOT NULL)`,
  ),
]);

/**
 * Which bed an admission occupied, and when. A transfer ends one stay and
 * starts the next; discharge ends the last. Bed-days are derived from these
 * (SCHEMA.md §7.2), never counted by hand.
 *
 * Migration 0010 adds `during`, a `tstzrange` computed from the two
 * instants, and two exclusion constraints on it: no bed holds two patients
 * at once, and no admission is in two beds at once. Drizzle cannot express
 * either, so they live in SQL only.
 */
export const bedStays = pgTable("bed_stays", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  admissionId: uuid().notNull(),
  bedId: uuid().notNull(),
  startedAt: timestamp({ withTimezone: true }).notNull(),
  endedAt: timestamp({ withTimezone: true }),
  startedBy: uuid().notNull(),
  endedBy: uuid(),
}, t => [
  unique("bed_stays_facility_id_id_key").on(t.facilityId, t.id),
  foreignKey({ name: "bed_stays_admission_fk", columns: [t.facilityId, t.admissionId], foreignColumns: [admissions.facilityId, admissions.id] }),
  foreignKey({ name: "bed_stays_bed_fk", columns: [t.facilityId, t.bedId], foreignColumns: [beds.facilityId, beds.id] }),
  foreignKey({ name: "bed_stays_started_by_fk", columns: [t.facilityId, t.startedBy], foreignColumns: [memberships.facilityId, memberships.id] }),
  foreignKey({ name: "bed_stays_ended_by_fk", columns: [t.facilityId, t.endedBy], foreignColumns: [memberships.facilityId, memberships.id] }),
  index("bed_stays_admission_index").on(t.facilityId, t.admissionId, t.startedAt),
  check("bed_stays_ends_after_start", sql`${t.endedAt} IS NULL OR ${t.endedAt} >= ${t.startedAt}`),
  check("bed_stays_ended_by_whom", sql`(${t.endedAt} IS NULL) = (${t.endedBy} IS NULL)`),
]);

// ---------------------------------------------------------------------------
// Charges (SCHEMA.md §7.2)
// ---------------------------------------------------------------------------

/**
 * What the hospital did for a patient, at what price: captured by the
 * module that did the work (rule 16), never typed in at the cashier.
 *
 * The price is copied at capture (SPEC.md D3) and the amount rounded once to
 * whole shillings (D2), so a later price change never alters a past charge.
 * A charge has one typed source, or none and a reason (a manual posting);
 * P2's sources are bed-days, and P3 and P4 add order items, procedures and
 * dispenses. After capture only its cancellation columns change.
 */
export const charges = pgTable("charges", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  encounterId: uuid().notNull(),
  billableItemId: uuid().notNull(),
  quantity: numeric({ precision: 11, scale: 3, mode: "string" }).notNull(),
  unitPriceCents: integer().notNull(),
  amountCents: integer().notNull(),
  /** The price used, for audit and re-pricing. */
  priceListItemId: uuid().notNull(),
  /** The Kenyan day the service was given; for a bed-day, the night it began. */
  serviceDate: date({ mode: "string" }).notNull(),
  bedStayId: uuid(),
  /** Why it was posted by hand, when it has no source. */
  manualReason: text(),
  /** Who posted it; null when the system captured it (a bed-day). */
  capturedBy: uuid(),
  capturedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  cancelledAt: timestamp({ withTimezone: true }),
  cancelledBy: uuid(),
  cancellationReason: text(),
}, t => [
  unique("charges_facility_id_id_key").on(t.facilityId, t.id),
  foreignKey({ name: "charges_encounter_fk", columns: [t.facilityId, t.encounterId], foreignColumns: [encounters.facilityId, encounters.id] }),
  foreignKey({ name: "charges_item_fk", columns: [t.facilityId, t.billableItemId], foreignColumns: [billableItems.facilityId, billableItems.id] }),
  foreignKey({ name: "charges_price_fk", columns: [t.facilityId, t.priceListItemId], foreignColumns: [priceListItems.facilityId, priceListItems.id] }),
  foreignKey({ name: "charges_bed_stay_fk", columns: [t.facilityId, t.bedStayId], foreignColumns: [bedStays.facilityId, bedStays.id] }),
  foreignKey({ name: "charges_captured_by_fk", columns: [t.facilityId, t.capturedBy], foreignColumns: [memberships.facilityId, memberships.id] }),
  foreignKey({ name: "charges_cancelled_by_fk", columns: [t.facilityId, t.cancelledBy], foreignColumns: [memberships.facilityId, memberships.id] }),
  index("charges_encounter_index").on(t.facilityId, t.encounterId, t.serviceDate),
  // One bed-day per admission per night, however often accrual runs.
  uniqueIndex("charges_one_bed_day_per_night").on(t.encounterId, t.serviceDate).where(sql`${t.bedStayId} IS NOT NULL`),
  check("charges_quantity_positive", sql`${t.quantity} > 0`),
  check("charges_unit_price_nonnegative", sql`${t.unitPriceCents} >= 0`),
  // Whole shillings: neither cash nor M-Pesa carries cents (SPEC.md D2).
  check("charges_amount_whole_shillings", sql`${t.amountCents} >= 0 AND ${t.amountCents} % 100 = 0`),
  // At most one source; none means a manual posting, which needs a reason and a person.
  check(
    "charges_source_or_reason",
    sql`num_nonnulls(${t.bedStayId}) <= 1
      AND ((num_nonnulls(${t.bedStayId}) = 0) = (${t.manualReason} IS NOT NULL AND length(btrim(${t.manualReason})) > 0))`,
  ),
  check("charges_manual_has_person", sql`${t.manualReason} IS NULL OR ${t.capturedBy} IS NOT NULL`),
  check(
    "charges_cancellation_complete",
    sql`(${t.cancelledAt} IS NULL AND ${t.cancelledBy} IS NULL AND ${t.cancellationReason} IS NULL)
      OR (${t.cancelledAt} IS NOT NULL AND ${t.cancelledBy} IS NOT NULL
          AND ${t.cancellationReason} IS NOT NULL AND length(btrim(${t.cancellationReason})) > 0)`,
  ),
]);

/**
 * A background job that could not do part of its work, for a person to fix
 * and the job to retry (CLAUDE.md §7). An unresolved failure is recorded
 * once, however many runs meet it. Outbox jobs keep their own `failed`
 * status instead.
 */
export const jobFailures = pgTable("job_failures", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  job: text().$type<"bed_day_accrual" | "reconciliation">().notNull(),
  /** What it was working on, e.g. the encounter. Not a foreign key: the log outlives it. */
  subjectId: uuid(),
  /** What is wrong, for whoever fixes it. Ids and codes only (rule 10). */
  error: text().notNull(),
  failedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp({ withTimezone: true }),
}, t => [
  // A facility-level failure has no subject; coalesced, so it too is open once.
  uniqueIndex("job_failures_open_once")
    .on(t.facilityId, t.job, sql`coalesce(${t.subjectId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.error)
    .where(sql`${t.resolvedAt} IS NULL`),
  oneOf("job_failures_job_known", t.job, ["bed_day_accrual", "reconciliation"]),
]);

// ---------------------------------------------------------------------------
// Accounts and invoices (SCHEMA.md §7.1, §7.3)
// ---------------------------------------------------------------------------

/**
 * A payer the facility bills: an insurer, or (P7) SHA. A thin P2 record, so
 * the money model can carry a payer split before payers are built out
 * (ROADMAP P2); the registry link, contract and schemes arrive in P7.
 */
export const payers = pgTable("payers", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  name: text().notNull(),
  isActive: boolean().default(true).notNull(),
  createdAt: createdAt(),
}, t => [
  unique("payers_facility_id_id_key").on(t.facilityId, t.id),
  unique("payers_facility_id_name_key").on(t.facilityId, t.name),
  check("payers_name_present", sql`length(btrim(${t.name})) > 0`),
]);

/**
 * A debtor: one per patient, one per payer. Every invoice, line, assignment,
 * payment, allocation, adjustment and refund belongs to exactly one, and the
 * references between them carry it (`facility_id, id, account_id`), so one
 * account's money can never settle another's bill (invariant M1).
 */
export const accounts = pgTable("accounts", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  kind: text().$type<"patient" | "payer">().notNull(),
  patientId: uuid(),
  payerId: uuid(),
  createdAt: createdAt(),
}, t => [
  unique("accounts_facility_id_id_key").on(t.facilityId, t.id),
  unique("accounts_facility_id_patient_id_key").on(t.facilityId, t.patientId),
  unique("accounts_facility_id_payer_id_key").on(t.facilityId, t.payerId),
  foreignKey({ name: "accounts_patient_fk", columns: [t.facilityId, t.patientId], foreignColumns: [patients.facilityId, patients.id] }),
  foreignKey({ name: "accounts_payer_fk", columns: [t.facilityId, t.payerId], foreignColumns: [payers.facilityId, payers.id] }),
  oneOf("accounts_kind_known", t.kind, ["patient", "payer"]),
  check("accounts_one_owner", sql`num_nonnulls(${t.patientId}, ${t.payerId}) = 1`),
  check("accounts_kind_matches", sql`(${t.kind} = 'patient') = (${t.patientId} IS NOT NULL)`),
]);

/**
 * Who is asked to pay which part of an encounter. A draft is built from the
 * encounter's charges; finalising it freezes its total and issues its
 * number and printed document (§6.2, rule 20). `status` is lifecycle only
 * (rule 17): an invoice's balance and whether it is paid are derived.
 */
export const invoices = pgTable("invoices", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  accountId: uuid().notNull(),
  encounterId: uuid().notNull(),
  kind: text().$type<"interim" | "final" | "supplementary">().notNull(),
  status: text().$type<"draft" | "finalised" | "void">().default("draft").notNull(),
  /** Frozen from the lines at finalisation. */
  totalCents: integer(),
  /** The printed invoice, carrying its number and QR code. */
  documentId: uuid(),
  createdBy: uuid().notNull(),
  createdAt: createdAt(),
  finalisedAt: timestamp({ withTimezone: true }),
  finalisedBy: uuid(),
  voidedAt: timestamp({ withTimezone: true }),
  voidedBy: uuid(),
  voidReason: text(),
}, t => [
  unique("invoices_facility_id_id_key").on(t.facilityId, t.id),
  // M1: what refers to an invoice names its account too.
  unique("invoices_facility_id_id_account_id_key").on(t.facilityId, t.id, t.accountId),
  foreignKey({ name: "invoices_account_fk", columns: [t.facilityId, t.accountId], foreignColumns: [accounts.facilityId, accounts.id] }),
  foreignKey({ name: "invoices_encounter_fk", columns: [t.facilityId, t.encounterId], foreignColumns: [encounters.facilityId, encounters.id] }),
  foreignKey({ name: "invoices_document_fk", columns: [t.facilityId, t.documentId], foreignColumns: [documents.facilityId, documents.id] }),
  foreignKey({ name: "invoices_created_by_fk", columns: [t.facilityId, t.createdBy], foreignColumns: [memberships.facilityId, memberships.id] }),
  foreignKey({ name: "invoices_finalised_by_fk", columns: [t.facilityId, t.finalisedBy], foreignColumns: [memberships.facilityId, memberships.id] }),
  foreignKey({ name: "invoices_voided_by_fk", columns: [t.facilityId, t.voidedBy], foreignColumns: [memberships.facilityId, memberships.id] }),
  // One live final invoice per encounter per account.
  uniqueIndex("invoices_one_live_final")
    .on(t.encounterId, t.accountId)
    .where(sql`${t.kind} = 'final' AND ${t.status} <> 'void'`),
  index("invoices_encounter_index").on(t.facilityId, t.encounterId),
  oneOf("invoices_kind_known", t.kind, ["interim", "final", "supplementary"]),
  oneOf("invoices_status_known", t.status, ["draft", "finalised", "void"]),
  check(
    "invoices_lifecycle",
    sql`(${t.status} = 'draft' AND ${t.totalCents} IS NULL AND ${t.documentId} IS NULL AND ${t.finalisedAt} IS NULL
          AND ${t.finalisedBy} IS NULL AND ${t.voidedAt} IS NULL AND ${t.voidedBy} IS NULL AND ${t.voidReason} IS NULL)
      OR (${t.status} = 'finalised' AND ${t.totalCents} IS NOT NULL AND ${t.documentId} IS NOT NULL
          AND ${t.finalisedAt} IS NOT NULL AND ${t.finalisedBy} IS NOT NULL
          AND ${t.voidedAt} IS NULL AND ${t.voidedBy} IS NULL AND ${t.voidReason} IS NULL)
      OR (${t.status} = 'void' AND ${t.voidedAt} IS NOT NULL AND ${t.voidedBy} IS NOT NULL
          AND ${t.voidReason} IS NOT NULL AND length(btrim(${t.voidReason})) > 0)`,
  ),
  check("invoices_total_whole_shillings", sql`${t.totalCents} IS NULL OR (${t.totalCents} >= 0 AND ${t.totalCents} % 100 = 0)`),
]);

/**
 * One line of an invoice, its description and code snapshotted (rule 7).
 * P2 lines are itemised, one per charge assignment; P7 adds package lines
 * (absorbing many charges) and rebill lines (from a disallowance).
 */
export const invoiceLines = pgTable("invoice_lines", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  invoiceId: uuid().notNull(),
  accountId: uuid().notNull(),
  kind: text().$type<"itemised">().notNull(),
  code: text().notNull(),
  description: text().notNull(),
  quantity: numeric({ precision: 11, scale: 3, mode: "string" }).notNull(),
  unitPriceCents: integer().notNull(),
  amountCents: integer().notNull(),
  serviceDate: date({ mode: "string" }).notNull(),
}, t => [
  unique("invoice_lines_facility_id_id_account_id_key").on(t.facilityId, t.id, t.accountId),
  foreignKey({
    name: "invoice_lines_invoice_fk",
    columns: [t.facilityId, t.invoiceId, t.accountId],
    foreignColumns: [invoices.facilityId, invoices.id, invoices.accountId],
  }),
  index("invoice_lines_invoice_index").on(t.invoiceId),
  oneOf("invoice_lines_kind_known", t.kind, ["itemised"]),
  check("invoice_lines_amount_whole_shillings", sql`${t.amountCents} > 0 AND ${t.amountCents} % 100 = 0`),
]);

/**
 * How much of a charge an invoice line asks one account to pay. Splitting a
 * charge (an insurer's 80%, the patient's 20%) is two assignments. Live
 * while its invoice is not void; Σ live assignments of a charge never
 * exceed its amount (M4).
 */
export const chargeAssignments = pgTable("charge_assignments", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  chargeId: uuid().notNull(),
  invoiceLineId: uuid().notNull(),
  accountId: uuid().notNull(),
  amountCents: integer().notNull(),
  mode: text().$type<"itemised" | "absorbed">().notNull(),
}, t => [
  foreignKey({ name: "charge_assignments_charge_fk", columns: [t.facilityId, t.chargeId], foreignColumns: [charges.facilityId, charges.id] }),
  foreignKey({
    name: "charge_assignments_line_fk",
    columns: [t.facilityId, t.invoiceLineId, t.accountId],
    foreignColumns: [invoiceLines.facilityId, invoiceLines.id, invoiceLines.accountId],
  }),
  index("charge_assignments_charge_index").on(t.chargeId),
  index("charge_assignments_line_index").on(t.invoiceLineId),
  oneOf("charge_assignments_mode_known", t.mode, ["itemised", "absorbed"]),
  check("charge_assignments_amount_whole_shillings", sql`${t.amountCents} > 0 AND ${t.amountCents} % 100 = 0`),
]);

/**
 * An amount taken off a finalised invoice (SCHEMA.md §7.5): a `credit_note`
 * corrects a billing error and is a numbered fiscal document; a `waiver`
 * forgives part of a bill; a `write_off` gives up on a debt. Requested by
 * one person and approved by another (rule 24). Approved adjustments share
 * the invoice's total with allocations (M3), and the balance is derived.
 * P7 adds the `payer_disallowance` kind and its disposition.
 */
export const invoiceAdjustments = pgTable("invoice_adjustments", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  invoiceId: uuid().notNull(),
  accountId: uuid().notNull(),
  kind: text().$type<"credit_note" | "waiver" | "write_off">().notNull(),
  amountCents: integer().notNull(),
  reason: text().notNull(),
  status: text().$type<"pending" | "approved" | "rejected" | "withdrawn">().default("pending").notNull(),
  requestedBy: uuid().notNull(),
  requestedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  decidedBy: uuid(),
  decidedAt: timestamp({ withTimezone: true }),
  /** An approved credit note's printed document, carrying its number. */
  documentId: uuid(),
  /** Set once, when a second person approves reversing it (`adjustment_reversals`). */
  reversedAt: timestamp({ withTimezone: true }),
  reversedBy: uuid(),
  reversalReason: text(),
}, t => [
  unique("invoice_adjustments_facility_id_id_key").on(t.facilityId, t.id),
  foreignKey({ name: "invoice_adjustments_reversed_by_fk", columns: [t.facilityId, t.reversedBy], foreignColumns: [memberships.facilityId, memberships.id] }),
  // Reversed only once approved, with a reason; each branch says IS NULL or IS NOT NULL outright.
  check(
    "invoice_adjustments_reversal",
    sql`(${t.reversedAt} IS NULL AND ${t.reversedBy} IS NULL AND ${t.reversalReason} IS NULL)
      OR (${t.status} = 'approved' AND ${t.reversedAt} IS NOT NULL AND ${t.reversedBy} IS NOT NULL
        AND ${t.reversalReason} IS NOT NULL AND length(btrim(${t.reversalReason})) > 0)`,
  ),
  foreignKey({
    name: "invoice_adjustments_invoice_fk",
    columns: [t.facilityId, t.invoiceId, t.accountId],
    foreignColumns: [invoices.facilityId, invoices.id, invoices.accountId],
  }),
  foreignKey({ name: "invoice_adjustments_document_fk", columns: [t.facilityId, t.documentId], foreignColumns: [documents.facilityId, documents.id] }),
  foreignKey({ name: "invoice_adjustments_requested_by_fk", columns: [t.facilityId, t.requestedBy], foreignColumns: [memberships.facilityId, memberships.id] }),
  foreignKey({ name: "invoice_adjustments_decided_by_fk", columns: [t.facilityId, t.decidedBy], foreignColumns: [memberships.facilityId, memberships.id] }),
  index("invoice_adjustments_invoice_index").on(t.invoiceId),
  index("invoice_adjustments_pending_index").on(t.facilityId).where(sql`${t.status} = 'pending'`),
  oneOf("invoice_adjustments_kind_known", t.kind, ["credit_note", "waiver", "write_off"]),
  oneOf("invoice_adjustments_status_known", t.status, ["pending", "approved", "rejected", "withdrawn"]),
  check("invoice_adjustments_amount_whole_shillings", sql`${t.amountCents} > 0 AND ${t.amountCents} % 100 = 0`),
  check("invoice_adjustments_reason_present", sql`length(btrim(${t.reason})) > 0`),
  // Approved or rejected by someone else; withdrawn only by the requester.
  check(
    "invoice_adjustments_decision",
    sql`(${t.status} = 'pending' AND ${t.decidedBy} IS NULL AND ${t.decidedAt} IS NULL)
      OR (${t.status} IN ('approved', 'rejected') AND ${t.decidedBy} IS NOT NULL AND ${t.decidedAt} IS NOT NULL
          AND ${t.decidedBy} <> ${t.requestedBy})
      OR (${t.status} = 'withdrawn' AND ${t.decidedBy} IS NOT NULL AND ${t.decidedBy} = ${t.requestedBy} AND ${t.decidedAt} IS NOT NULL)`,
  ),
  check(
    "invoice_adjustments_credit_note_document",
    sql`(${t.kind} = 'credit_note' AND ${t.status} = 'approved') = (${t.documentId} IS NOT NULL)`,
  ),
]);

/**
 * A request to undo an approved adjustment (SCHEMA.md §7.5). Asked by one
 * person, approved by another (rule 24); approving sets the adjustment's
 * reversal columns, returning its amount to the invoice's balance, and voids
 * a credit note's document. At most one is open (pending or approved) per
 * adjustment.
 */
export const adjustmentReversals = pgTable("adjustment_reversals", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  adjustmentId: uuid().notNull(),
  reason: text().notNull(),
  status: text().$type<"pending" | "approved" | "rejected" | "withdrawn">().default("pending").notNull(),
  requestedBy: uuid().notNull(),
  requestedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  decidedBy: uuid(),
  decidedAt: timestamp({ withTimezone: true }),
}, t => [
  foreignKey({ name: "adjustment_reversals_adjustment_fk", columns: [t.facilityId, t.adjustmentId], foreignColumns: [invoiceAdjustments.facilityId, invoiceAdjustments.id] }),
  foreignKey({ name: "adjustment_reversals_requested_by_fk", columns: [t.facilityId, t.requestedBy], foreignColumns: [memberships.facilityId, memberships.id] }),
  foreignKey({ name: "adjustment_reversals_decided_by_fk", columns: [t.facilityId, t.decidedBy], foreignColumns: [memberships.facilityId, memberships.id] }),
  uniqueIndex("adjustment_reversals_one_open").on(t.adjustmentId).where(sql`${t.status} IN ('pending', 'approved')`),
  oneOf("adjustment_reversals_status_known", t.status, ["pending", "approved", "rejected", "withdrawn"]),
  check("adjustment_reversals_reason_present", sql`length(btrim(${t.reason})) > 0`),
  check(
    "adjustment_reversals_decision",
    sql`(${t.status} = 'pending' AND ${t.decidedBy} IS NULL AND ${t.decidedAt} IS NULL)
      OR (${t.status} IN ('approved', 'rejected') AND ${t.decidedBy} IS NOT NULL AND ${t.decidedAt} IS NOT NULL
          AND ${t.decidedBy} <> ${t.requestedBy})
      OR (${t.status} = 'withdrawn' AND ${t.decidedBy} IS NOT NULL AND ${t.decidedBy} = ${t.requestedBy} AND ${t.decidedAt} IS NOT NULL)`,
  ),
]);

// ---------------------------------------------------------------------------
// Payments (SCHEMA.md §7.4)
// ---------------------------------------------------------------------------

/**
 * A cashier's turn at the counter. Cash and card are taken inside one
 * (decided 2026-11-04). At close the cashier declares the cash counted;
 * what was expected, and the variance, are derived from the shift's payments.
 */
export const cashierShifts = pgTable("cashier_shifts", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  /** The cashier's membership. */
  cashierId: uuid().notNull(),
  openedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  openingFloatCents: integer().default(0).notNull(),
  closedAt: timestamp({ withTimezone: true }),
  declaredCashCents: integer(),
}, t => [
  unique("cashier_shifts_facility_id_id_key").on(t.facilityId, t.id),
  // A payment's shift names its cashier too, so it is always the receiver's own.
  unique("cashier_shifts_facility_id_id_cashier_id_key").on(t.facilityId, t.id, t.cashierId),
  foreignKey({ name: "cashier_shifts_cashier_fk", columns: [t.facilityId, t.cashierId], foreignColumns: [memberships.facilityId, memberships.id] }),
  uniqueIndex("cashier_shifts_one_open").on(t.facilityId, t.cashierId).where(sql`${t.closedAt} IS NULL`),
  check("cashier_shifts_float_whole_shillings", sql`${t.openingFloatCents} >= 0 AND ${t.openingFloatCents} % 100 = 0`),
  check(
    "cashier_shifts_closing",
    sql`(${t.closedAt} IS NULL AND ${t.declaredCashCents} IS NULL)
      OR (${t.closedAt} IS NOT NULL AND ${t.declaredCashCents} IS NOT NULL AND ${t.declaredCashCents} >= 0 AND ${t.declaredCashCents} % 100 = 0)`,
  ),
]);

// ---------------------------------------------------------------------------
// M-Pesa (SCHEMA.md §7.4, P2 slice 6)
// ---------------------------------------------------------------------------

/**
 * A facility's paybill and Daraja credentials, set by its admin (decided
 * 2026-11-06). The consumer key, secret and STK passkey are stored as one
 * value encrypted with CREDENTIALS_ENCRYPTION_KEY and never returned. The
 * callback token is the secret in this facility's callback URLs: a call
 * from Safaricom carries no session, and the token is what names the
 * facility (the shortcode in its body is caller-supplied and decides
 * nothing).
 */
export const mpesaSettings = pgTable("mpesa_settings", {
  facilityId: uuid().primaryKey().references(() => facilities.id),
  shortcode: text().notNull(),
  credentials: text().notNull(),
  callbackToken: text().notNull().unique(),
  /** When Safaricom last accepted this paybill's C2B callback URLs. */
  urlsRegisteredAt: timestamp({ withTimezone: true }),
  updatedBy: uuid().notNull(),
  updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, t => [
  foreignKey({ name: "mpesa_settings_updated_by_fk", columns: [t.facilityId, t.updatedBy], foreignColumns: [memberships.facilityId, memberships.id] }),
  check("mpesa_settings_shortcode_shape", sql`${t.shortcode} ~ '^[0-9]{5,7}$'`),
  check("mpesa_settings_callback_token_shape", sql`${t.callbackToken} ~ '^[A-Za-z0-9_-]{43}$'`),
]);

/**
 * Money Safaricom says arrived, exactly as it said it: a paybill (C2B)
 * confirmation or a successful STK push. Append-only but for its status
 * (unmatched → allocated, or rejected; back to unmatched if its payment is
 * reversed), so "where did this money go" always has the original evidence.
 * A payment points here; the receipt number is unique per facility, which is
 * what makes a Safaricom retry harmless.
 */
export const mpesaTransactions = pgTable("mpesa_transactions", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  source: text().$type<"c2b" | "stk">().notNull(),
  /** Safaricom's receipt number, e.g. `SKL4H7XQ2P`. */
  transactionId: text().notNull(),
  shortcode: text().notNull(),
  /** What the payer typed as the account number (C2B only). */
  accountReference: text(),
  /** The paying phone: E.164 when Safaricom sends it whole, else as sent (often masked). */
  msisdn: text().notNull(),
  payerName: text(),
  amountCents: integer().notNull(),
  transactedAt: timestamp({ withTimezone: true }).notNull(),
  rawPayload: jsonb().notNull(),
  status: text().$type<"unmatched" | "allocated" | "rejected">().default("unmatched").notNull(),
  statusReason: text(),
  receivedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, t => [
  unique("mpesa_transactions_facility_id_id_key").on(t.facilityId, t.id),
  unique("mpesa_transactions_facility_id_transaction_id_key").on(t.facilityId, t.transactionId),
  index("mpesa_transactions_status_index").on(t.facilityId, t.status),
  // An early STK callback, found by its checkout id once the send records it.
  index("mpesa_transactions_stk_checkout_index").on(t.facilityId, stkCheckoutId(t.rawPayload)).where(sql`${t.source} = 'stk'`),
  oneOf("mpesa_transactions_source_known", t.source, ["c2b", "stk"]),
  oneOf("mpesa_transactions_status_known", t.status, ["unmatched", "allocated", "rejected"]),
  check("mpesa_transactions_amount_whole_shillings", sql`${t.amountCents} > 0 AND ${t.amountCents} % 100 = 0`),
  check(
    "mpesa_transactions_rejected_reason",
    sql`${t.status} <> 'rejected' OR (${t.statusReason} IS NOT NULL AND length(btrim(${t.statusReason})) > 0)`,
  ),
]);

/**
 * A prompt sent to a patient's phone to pay the paybill, asked for at the
 * counter and sent through the outbox (rule 18). Its outcome comes back on
 * Safaricom's callback: `completed` names the transaction that paid it.
 */
export const mpesaStkRequests = pgTable("mpesa_stk_requests", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  patientId: uuid().notNull(),
  /** What it pays: a bill, a visit or admission (a deposit), or neither (credit). */
  invoiceId: uuid(),
  encounterId: uuid(),
  /** The phone prompted, E.164 (rule 13). */
  phone: text().notNull(),
  amountCents: integer().notNull(),
  requestedBy: uuid().notNull(),
  requestedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  /** `sending` is set before Safaricom is called and never sent from again: a crash there must not prompt twice. */
  status: text().$type<"queued" | "sending" | "sent" | "completed" | "failed">().default("queued").notNull(),
  checkoutRequestId: text(),
  resultCode: integer(),
  resultDesc: text(),
  mpesaTransactionId: uuid(),
  completedAt: timestamp({ withTimezone: true }),
}, t => [
  unique("mpesa_stk_requests_facility_id_id_key").on(t.facilityId, t.id),
  uniqueIndex("mpesa_stk_requests_checkout_index").on(t.facilityId, t.checkoutRequestId).where(sql`${t.checkoutRequestId} IS NOT NULL`),
  foreignKey({ name: "mpesa_stk_requests_patient_fk", columns: [t.facilityId, t.patientId], foreignColumns: [patients.facilityId, patients.id] }),
  foreignKey({ name: "mpesa_stk_requests_invoice_fk", columns: [t.facilityId, t.invoiceId], foreignColumns: [invoices.facilityId, invoices.id] }),
  foreignKey({ name: "mpesa_stk_requests_encounter_fk", columns: [t.facilityId, t.encounterId], foreignColumns: [encounters.facilityId, encounters.id] }),
  foreignKey({ name: "mpesa_stk_requests_requested_by_fk", columns: [t.facilityId, t.requestedBy], foreignColumns: [memberships.facilityId, memberships.id] }),
  foreignKey({ name: "mpesa_stk_requests_transaction_fk", columns: [t.facilityId, t.mpesaTransactionId], foreignColumns: [mpesaTransactions.facilityId, mpesaTransactions.id] }),
  oneOf("mpesa_stk_requests_status_known", t.status, ["queued", "sending", "sent", "completed", "failed"]),
  check("mpesa_stk_requests_phone_e164", sql`${t.phone} ~ '^\\+254[0-9]{9}$'`),
  check("mpesa_stk_requests_amount_whole_shillings", sql`${t.amountCents} > 0 AND ${t.amountCents} % 100 = 0`),
  check("mpesa_stk_requests_one_target", sql`${t.invoiceId} IS NULL OR ${t.encounterId} IS NULL`),
  // Each branch says IS NULL or IS NOT NULL outright: a CHECK passes on NULL.
  check(
    "mpesa_stk_requests_lifecycle",
    sql`(${t.status} IN ('queued', 'sending') AND ${t.checkoutRequestId} IS NULL AND ${t.mpesaTransactionId} IS NULL AND ${t.completedAt} IS NULL)
      OR (${t.status} = 'sent' AND ${t.checkoutRequestId} IS NOT NULL AND ${t.mpesaTransactionId} IS NULL AND ${t.completedAt} IS NULL)
      OR (${t.status} = 'completed' AND ${t.checkoutRequestId} IS NOT NULL AND ${t.mpesaTransactionId} IS NOT NULL AND ${t.completedAt} IS NOT NULL)
      OR (${t.status} = 'failed' AND ${t.mpesaTransactionId} IS NULL AND ${t.completedAt} IS NOT NULL)`,
  ),
]);

/**
 * Each call to or from Safaricom that is not a C2B confirmation (those are
 * `mpesa_transactions`): what was sent, without secrets, and what came back.
 * Append-only (rule 18). Payloads live here, never in logs (rule 10).
 */
export const gatewayExchanges = pgTable("gateway_exchanges", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  gateway: text().$type<"daraja">().notNull(),
  operation: text().$type<"register_urls" | "stk_push" | "stk_callback" | "c2b_confirmation">().notNull(),
  /** The STK request an `stk_*` exchange belongs to, when it is known. */
  stkRequestId: uuid(),
  request: jsonb(),
  response: jsonb(),
  httpStatus: integer(),
  error: text(),
  createdAt: createdAt(),
}, t => [
  foreignKey({ name: "gateway_exchanges_stk_request_fk", columns: [t.facilityId, t.stkRequestId], foreignColumns: [mpesaStkRequests.facilityId, mpesaStkRequests.id] }),
  index("gateway_exchanges_stk_request_index").on(t.stkRequestId),
  // An early refusal, found by its checkout id once the send records it.
  index("gateway_exchanges_stk_checkout_index").on(t.facilityId, stkCheckoutId(t.response)).where(sql`${t.operation} = 'stk_callback'`),
  oneOf("gateway_exchanges_gateway_known", t.gateway, ["daraja"]),
  oneOf("gateway_exchanges_operation_known", t.operation, ["register_urls", "stk_push", "stk_callback", "c2b_confirmation"]),
  check("gateway_exchanges_register_has_no_request", sql`${t.operation} NOT IN ('register_urls', 'c2b_confirmation') OR ${t.stkRequestId} IS NULL`),
]);

/**
 * Money received, as credit on one account. Allocations decide which bills
 * it settles; what is not allocated is the account's credit (a deposit).
 * Every payment has its receipt, issued in the same transaction (rule 20).
 * Reversed, never edited (SCHEMA.md §10). Slice 6 adds the M-Pesa methods.
 */
export const payments = pgTable("payments", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  accountId: uuid().notNull(),
  method: text().$type<"cash" | "card" | "bank" | "mpesa_c2b" | "mpesa_stk">().notNull(),
  amountCents: integer().notNull(),
  /** The card slip's or bank transfer's reference, or the M-Pesa receipt number; cash has none. */
  reference: text(),
  /** Required for cash and card. */
  cashierShiftId: uuid(),
  /** The visit or admission it was paid towards, e.g. an admission deposit. */
  encounterId: uuid(),
  /** The receipt, carrying its number. */
  documentId: uuid().notNull(),
  receivedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  /** Who took it; null for M-Pesa the system matched by itself. */
  receivedBy: uuid(),
  /** The M-Pesa transaction it records, for the M-Pesa methods. */
  mpesaTransactionId: uuid(),
  reversedAt: timestamp({ withTimezone: true }),
  reversedBy: uuid(),
  reversalReason: text(),
}, t => [
  unique("payments_facility_id_id_key").on(t.facilityId, t.id),
  foreignKey({ name: "payments_mpesa_transaction_fk", columns: [t.facilityId, t.mpesaTransactionId], foreignColumns: [mpesaTransactions.facilityId, mpesaTransactions.id] }),
  // One live payment per M-Pesa transaction: a retry or a race cannot pay twice.
  uniqueIndex("payments_one_live_per_mpesa_transaction").on(t.mpesaTransactionId).where(sql`${t.reversedAt} IS NULL`),
  check("payments_mpesa_transaction", sql`(${t.method} IN ('mpesa_c2b', 'mpesa_stk')) = (${t.mpesaTransactionId} IS NOT NULL)`),
  check("payments_received_by", sql`${t.receivedBy} IS NOT NULL OR ${t.method} IN ('mpesa_c2b', 'mpesa_stk')`),
  // M1: what refers to a payment names its account too.
  unique("payments_facility_id_id_account_id_key").on(t.facilityId, t.id, t.accountId),
  foreignKey({ name: "payments_account_fk", columns: [t.facilityId, t.accountId], foreignColumns: [accounts.facilityId, accounts.id] }),
  foreignKey({
    name: "payments_shift_fk",
    columns: [t.facilityId, t.cashierShiftId, t.receivedBy],
    foreignColumns: [cashierShifts.facilityId, cashierShifts.id, cashierShifts.cashierId],
  }),
  foreignKey({ name: "payments_encounter_fk", columns: [t.facilityId, t.encounterId], foreignColumns: [encounters.facilityId, encounters.id] }),
  foreignKey({ name: "payments_document_fk", columns: [t.facilityId, t.documentId], foreignColumns: [documents.facilityId, documents.id] }),
  foreignKey({ name: "payments_received_by_fk", columns: [t.facilityId, t.receivedBy], foreignColumns: [memberships.facilityId, memberships.id] }),
  foreignKey({ name: "payments_reversed_by_fk", columns: [t.facilityId, t.reversedBy], foreignColumns: [memberships.facilityId, memberships.id] }),
  index("payments_account_index").on(t.accountId),
  index("payments_shift_index").on(t.cashierShiftId),
  index("payments_encounter_index").on(t.encounterId),
  oneOf("payments_method_known", t.method, ["cash", "card", "bank", "mpesa_c2b", "mpesa_stk"]),
  check("payments_amount_whole_shillings", sql`${t.amountCents} > 0 AND ${t.amountCents} % 100 = 0`),
  check(
    "payments_reference",
    sql`(${t.method} = 'cash' AND ${t.reference} IS NULL)
      OR (${t.method} <> 'cash' AND ${t.reference} IS NOT NULL AND length(btrim(${t.reference})) > 0)`,
  ),
  check("payments_counter_shift", sql`(${t.method} IN ('cash', 'card')) = (${t.cashierShiftId} IS NOT NULL)`),
  // Reversed with a reason, and never by the person who took it (decided 2026-11-04).
  check(
    "payments_reversal",
    sql`(${t.reversedAt} IS NULL AND ${t.reversedBy} IS NULL AND ${t.reversalReason} IS NULL)
      OR (${t.reversedAt} IS NOT NULL AND ${t.reversedBy} IS NOT NULL AND ${t.reversalReason} IS NOT NULL AND length(btrim(${t.reversalReason})) > 0
          AND (${t.receivedBy} IS NULL OR ${t.reversedBy} <> ${t.receivedBy}))`,
  ),
]);

/**
 * How much of a payment settles one invoice. Live while neither it nor its
 * payment is reversed. Σ live allocations of a payment never exceed it (M2);
 * of an invoice, together with approved adjustments, never its total (M3).
 */
export const allocations = pgTable("allocations", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  paymentId: uuid().notNull(),
  invoiceId: uuid().notNull(),
  accountId: uuid().notNull(),
  amountCents: integer().notNull(),
  /** Null when the system applied it: a matched M-Pesa payment. */
  allocatedBy: uuid(),
  allocatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  reversedAt: timestamp({ withTimezone: true }),
  reversedBy: uuid(),
  reversalReason: text(),
}, t => [
  foreignKey({
    name: "allocations_payment_fk",
    columns: [t.facilityId, t.paymentId, t.accountId],
    foreignColumns: [payments.facilityId, payments.id, payments.accountId],
  }),
  foreignKey({
    name: "allocations_invoice_fk",
    columns: [t.facilityId, t.invoiceId, t.accountId],
    foreignColumns: [invoices.facilityId, invoices.id, invoices.accountId],
  }),
  foreignKey({ name: "allocations_allocated_by_fk", columns: [t.facilityId, t.allocatedBy], foreignColumns: [memberships.facilityId, memberships.id] }),
  foreignKey({ name: "allocations_reversed_by_fk", columns: [t.facilityId, t.reversedBy], foreignColumns: [memberships.facilityId, memberships.id] }),
  index("allocations_payment_index").on(t.paymentId),
  index("allocations_invoice_index").on(t.invoiceId),
  check("allocations_amount_whole_shillings", sql`${t.amountCents} > 0 AND ${t.amountCents} % 100 = 0`),
  check(
    "allocations_reversal",
    sql`(${t.reversedAt} IS NULL AND ${t.reversedBy} IS NULL AND ${t.reversalReason} IS NULL)
      OR (${t.reversedAt} IS NOT NULL AND ${t.reversedBy} IS NOT NULL AND ${t.reversalReason} IS NOT NULL AND length(btrim(${t.reversalReason})) > 0)`,
  ),
]);

/**
 * Unused credit paid back from one payment (SCHEMA.md §7.4). A biller asks,
 * the finance manager or the facility admin approves, never the person who
 * asked (rule 24); a cashier then pays it out, and only then does it take its
 * number (rule 20). From approval until it is reversed it holds its share of
 * the payment: Σ live allocations + Σ live refunds ≤ the payment (M2).
 * Reversal cancels an approval not yet paid out, or corrects a payout
 * recorded in error; never by whoever paid it out.
 */
export const refunds = pgTable("refunds", {
  id: uuid().primaryKey().defaultRandom(),
  facilityId: uuid().notNull().references(() => facilities.id),
  paymentId: uuid().notNull(),
  accountId: uuid().notNull(),
  amountCents: integer().notNull(),
  reason: text().notNull(),
  status: text().$type<"pending" | "approved" | "rejected" | "withdrawn">().default("pending").notNull(),
  requestedBy: uuid().notNull(),
  requestedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  decidedBy: uuid(),
  decidedAt: timestamp({ withTimezone: true }),
  /** Set together when the money is paid out. */
  paidAt: timestamp({ withTimezone: true }),
  paidBy: uuid(),
  method: text().$type<"cash" | "card" | "bank" | "mpesa">(),
  /** The card slip's, bank transfer's or M-Pesa transaction's reference; cash has none. */
  reference: text(),
  /** Required for cash and card: the drawer the money came from. */
  cashierShiftId: uuid(),
  /** The refund's printed document, carrying its number. */
  documentId: uuid(),
  reversedAt: timestamp({ withTimezone: true }),
  reversedBy: uuid(),
  reversalReason: text(),
}, t => [
  // M1: the refund's account is its payment's.
  foreignKey({
    name: "refunds_payment_fk",
    columns: [t.facilityId, t.paymentId, t.accountId],
    foreignColumns: [payments.facilityId, payments.id, payments.accountId],
  }),
  foreignKey({
    name: "refunds_shift_fk",
    columns: [t.facilityId, t.cashierShiftId, t.paidBy],
    foreignColumns: [cashierShifts.facilityId, cashierShifts.id, cashierShifts.cashierId],
  }),
  foreignKey({ name: "refunds_document_fk", columns: [t.facilityId, t.documentId], foreignColumns: [documents.facilityId, documents.id] }),
  foreignKey({ name: "refunds_requested_by_fk", columns: [t.facilityId, t.requestedBy], foreignColumns: [memberships.facilityId, memberships.id] }),
  foreignKey({ name: "refunds_decided_by_fk", columns: [t.facilityId, t.decidedBy], foreignColumns: [memberships.facilityId, memberships.id] }),
  foreignKey({ name: "refunds_paid_by_fk", columns: [t.facilityId, t.paidBy], foreignColumns: [memberships.facilityId, memberships.id] }),
  foreignKey({ name: "refunds_reversed_by_fk", columns: [t.facilityId, t.reversedBy], foreignColumns: [memberships.facilityId, memberships.id] }),
  index("refunds_payment_index").on(t.paymentId),
  index("refunds_shift_index").on(t.cashierShiftId),
  oneOf("refunds_status_known", t.status, ["pending", "approved", "rejected", "withdrawn"]),
  oneOf("refunds_method_known", t.method, ["cash", "card", "bank", "mpesa"]),
  check("refunds_amount_whole_shillings", sql`${t.amountCents} > 0 AND ${t.amountCents} % 100 = 0`),
  check("refunds_reason_present", sql`length(btrim(${t.reason})) > 0`),
  // Approved or rejected by someone else; withdrawn only by the requester.
  check(
    "refunds_decision",
    sql`(${t.status} = 'pending' AND ${t.decidedBy} IS NULL AND ${t.decidedAt} IS NULL)
      OR (${t.status} IN ('approved', 'rejected') AND ${t.decidedBy} IS NOT NULL AND ${t.decidedAt} IS NOT NULL
          AND ${t.decidedBy} <> ${t.requestedBy})
      OR (${t.status} = 'withdrawn' AND ${t.decidedBy} IS NOT NULL AND ${t.decidedBy} = ${t.requestedBy} AND ${t.decidedAt} IS NOT NULL)`,
  ),
  // Paid out only once approved, with every payout detail, or none of them.
  // Each branch says IS NULL or IS NOT NULL outright: a CHECK passes on NULL.
  check(
    "refunds_payout",
    sql`(${t.paidAt} IS NULL AND ${t.paidBy} IS NULL AND ${t.method} IS NULL AND ${t.reference} IS NULL
        AND ${t.cashierShiftId} IS NULL AND ${t.documentId} IS NULL)
      OR (${t.status} = 'approved' AND ${t.paidAt} IS NOT NULL AND ${t.paidBy} IS NOT NULL AND ${t.documentId} IS NOT NULL
        AND ${t.method} IS NOT NULL
        AND ((${t.method} = 'cash' AND ${t.reference} IS NULL AND ${t.cashierShiftId} IS NOT NULL)
          OR (${t.method} = 'card' AND ${t.reference} IS NOT NULL AND length(btrim(${t.reference})) > 0 AND ${t.cashierShiftId} IS NOT NULL)
          OR (${t.method} IN ('bank', 'mpesa') AND ${t.reference} IS NOT NULL AND length(btrim(${t.reference})) > 0 AND ${t.cashierShiftId} IS NULL)))`,
  ),
  // Reversed only once approved, with a reason, and never by whoever paid it out.
  check(
    "refunds_reversal",
    sql`(${t.reversedAt} IS NULL AND ${t.reversedBy} IS NULL AND ${t.reversalReason} IS NULL)
      OR (${t.status} = 'approved' AND ${t.reversedAt} IS NOT NULL AND ${t.reversedBy} IS NOT NULL
        AND ${t.reversalReason} IS NOT NULL AND length(btrim(${t.reversalReason})) > 0
        AND (${t.paidBy} IS NULL OR ${t.reversedBy} <> ${t.paidBy}))`,
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
  "documents",
  "patients",
  "patient_numbers",
  "patient_identifiers",
  "wards",
  "beds",
  "encounters",
  "admissions",
  "bed_stays",
  "billable_items",
  "price_lists",
  "price_changes",
  "price_change_lines",
  "price_list_items",
  "charges",
  "job_failures",
  "payers",
  "accounts",
  "invoices",
  "invoice_lines",
  "charge_assignments",
  "invoice_adjustments",
  "adjustment_reversals",
  "cashier_shifts",
  "payments",
  "allocations",
  "refunds",
  "mpesa_settings",
  "mpesa_transactions",
  "mpesa_stk_requests",
  "gateway_exchanges",
] as const;
