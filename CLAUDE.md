# CLAUDE.md

Project context for AI assistants working in this repository. Read this before writing code.

`SPEC.md` is the source of truth for decisions and open questions. `SCHEMA.md` holds the data model and `ROADMAP.md` the order of work. This file holds the conventions that code must follow. Conventions were adapted from the school management SaaS (school-saas-api) and extended for health data and hospital billing. Where a choice is not yet decided, this file says so. **Do not silently decide an open item; ask.**

---

## 1. What this is

A multi-tenant hospital management SaaS for Kenya, designed first for **Level 4 private and mission hospitals** (roughly 20–150 beds). Sold to many hospitals. **Each facility is a tenant**: one KMHFR facility code, one SHA contract.

**In scope for v1** (phases P1–P8 in `ROADMAP.md`; the pilot goes live as a cash hospital in P6, before payers in P7):

- Patient records (multiple identifiers per patient, OP and IP numbers)
- Service-point queues and appointments
- OPD consultations: triage and vitals, ICD diagnoses, notes, orders, printable prescriptions
- Lab: test catalogue, specimens, results with second-person verification
- Inpatient: admissions, wards and beds, transfers, nursing notes, observation charts, medication administration, discharge summaries
- Pharmacy and stores: shared drug catalogue, per-facility stock and prices, sub-stores and transfers, dispensing, controlled-drug register
- Billing: charges captured at source, payer-split invoices, deposits, refunds, cashier shifts, receipts; cash, card, bank, M-Pesa paybill (C2B) and STK push
- **SHA and private insurers**: coverages, eligibility checks, preauthorizations, claims, remittances
- Reports: revenue and cashier summaries, debtors by payer, MOH 705A/705B and 717, stock status

**Out of scope for v1.** Do not build these unless asked: theatre scheduling, maternity/partograph, PACS, lab analyser interfaces, automatic KHIS/DHIS2 push, double-entry ledger, supplier payables, payroll, insurer e-claims (SMART, Slade360), patient portal, telehealth. eTIMS waits on a tax adviser's answer (`SPEC.md` D7).

**Simplicity is the product's main differentiator** (`SPEC.md` §7.9). Hospitals already have certified systems; they switch because those systems are too complex for ordinary staff. Shape endpoints around each role's tasks, and never ask a user for something the system can derive.

**SHA claims go live only after DHA certification.** SHA contracts only facilities on a DHA-certified HMIS, and its manual portal is closing (`SPEC.md` §8). Build the SHA integration against the AfyaConnect sandbox; never assume a manual SHA channel exists. Each has room in the design; see `ROADMAP.md` §3.

---

## 2. Stack

| Layer | Choice | Status |
|---|---|---|
| Hosting | Google Cloud Run | Confirmed (initially) |
| Database | PostgreSQL. Production and staging on the same host, chosen by the residency answer: Cloud SQL in Johannesburg (`africa-south1`) if hosting outside Kenya is allowed, a Kenyan host if not | Postgres confirmed; host open |
| Local dev/test | Docker Postgres (separate dev and test databases) + Docker Redis | Confirmed (same pattern as the school SaaS) |
| Redis in production | Upstash Redis | Confirmed |
| Rate limiting | Redis-backed `rate-limiter-flexible`, with an in-memory first layer and fallback | In use on sign-in and invitation acceptance (P1) |
| File storage | Google Cloud Storage | Confirmed |
| Backend | Hono + `@hono/zod-openapi`, Drizzle ORM | Confirmed |
| Frontend | Next.js, built as a PWA | Proposed |
| Auth | Better Auth, email and password, invite-only (no public sign-up) | Confirmed |
| Tenant resolution | One address for all facilities; the facility comes from the signed-in user's membership, never the hostname (section 4) | Confirmed |
| Payments | Safaricom Daraja: C2B paybill per facility, plus STK push | Proposed |
| Payer integration | `PayerGateway`: `manual` for private insurers; `afyaconnect` for SHA through DHA's integration platform, live only after certification | Proposed |
| External calls | Transactional outbox, drained by Cloud Tasks workers | In use (P1) |
| PDF rendering | pdfmake (tables across pages, built-in QR codes, no headless browser). A document's frozen data is the source of truth; the PDF is rendered from it | Confirmed |
| Email | Resend, behind a small `sendEmail` interface | Confirmed |
| SMS | Africa's Talking, behind a small `sendSms` interface. Brevo is the option to revisit for WhatsApp reminders | Confirmed |
| Background jobs | Cloud Tasks + Cloud Scheduler, created over REST (no gRPC client) | In use (P1): the outbox drain. Setup in `docs/deployment.md` |

Not yet decided: production database host and region, and storage bucket location. Both depend on the data residency question in `SPEC.md`.

---

## 3. Non-negotiable conventions

These are load-bearing. Do not deviate without discussion.

1. **`facilityId` on every tenant table**, even where it is derivable through a foreign key. RLS policies and the tenant guard depend on it. The one listed exception is the **shared reference tables** (`icd_codes`, `drug_catalogue`, `sha_tariffs`, `payer_registry`), which carry no `facility_id` and are read-only to the app role.
2. **Never query the raw owner `db` from a route handler.** Use `c.get('db')`, the per-request tenant transaction (section 4). A test fails the build on a stray import.
3. **Money is integer cents** (KES), never floats. Field names end in `Cents`. Payments, allocations and refunds are whole shillings, because neither M-Pesa nor cash carries cents. *Unit prices* may carry fractional shillings (KES 2.50 a tablet); each charge's amount is rounded to whole shillings once, at capture (`SPEC.md` D2).
4. **Balances, settlement and stock are derived, never stored.** An invoice's balance, whether a claim is paid, how much of a charge is assigned, bed-days, the patient-deposits liability, and stock on hand are all computed from the rows beneath them.
5. **Nothing hard-deletes.** Patients, encounters, notes, orders, results, charges, invoices, payments, claims and stock movements are only status-transitioned, reversed or superseded. The runtime role holds no `DELETE` on domain tables. Any exception must be listed explicitly here. There are none yet.
6. **Every money row belongs to one debtor account** (patient or payer). Invoices, payments, allocations, adjustments and refunds carry `account_id` in three-column foreign keys, `(facility_id, id, account_id)`, so applying one account's money to another account's bill cannot be stored (`SCHEMA.md` §7.1, M1). Every encounter has a billing plan; self-pay is a plan, not the absence of one.
7. **Snapshot what is printed, billed or claimed.** Charges copy the price at capture and invoice lines copy it from the charge; neither joins the price list (`SPEC.md` D3). Receipts, prescriptions, invoices, claims, verified results, signed notes and discharge summaries freeze when finalised. A later price or catalogue change must never alter a past document.
8. **Store coded clinical data**: ICD codes for diagnoses (ICD-10 vs ICD-11 is open: `SPEC.md` §4), intervention and procedure codes, catalogue codes for services and drugs, and the practitioner's licence number on clinical acts. Claims and MOH reporting need them.
9. **Audit reads as well as writes.** `audit_log` is append-only, written inside the same transaction as the action. The runtime role holds `INSERT` and `SELECT` only. Record who *viewed* a patient record or document, not just who changed one.
10. **No patient data outside the database.** No names, phone numbers, national IDs, member numbers, diagnoses, or clinical details in logs, Redis keys, queue payloads, URLs, or file names and object keys. Use IDs only. Payloads sent to payers are stored in `gateway_exchanges` in the database, never in logs.
11. **Files: store the object key, never a URL.** The bucket comes from environment config. Access is a permission check, then an audit entry, then a short-lived signed URL. Never persist signed URLs.
12. **Controlled drugs carry a flag and a schedule (I–IV).** Dispensing them writes to a separate register (patient, prescriber, quantity, running balance) and is limited to authorized roles.
13. **Phone numbers stored E.164** (`+2547...`). Normalise on write.
14. **Dates are `date`; instants are `timestamp`.**
15. **A `.$type<"a" | "b">()` text column carries a matching `CHECK`.** The type constrains this codebase and nothing else; a seed or hand-run correction can put any value in a text column, and the failure is silent (rows stop matching filters). Enforce with a test, as in the school SaaS.
16. **Charges are captured at source.** The module that did the work (consultation, lab, pharmacy, ward) raises the charge. An invoice line references a charge, a package, or an adjustment, never free text. Manual posting exists for gaps, requires a reason, and is audited.
17. **Status means lifecycle only.** No `paid` on invoices or claims, no `settled` anywhere. Paid, approved, partially approved and rejected are derived from allocations and adjudicated amounts.
18. **No external I/O inside a tenant transaction.** Calls to SHA, insurers, Daraja, SMS and email go through the outbox: write the intent, commit, call, record the result in a new transaction. Raw exchanges are stored append-only. A slow endpoint must never hold a number-series or allocation lock.
19. **Finalised means immutable**, enforced by triggers and tested. Corrections are a credit note, a new version or an addendum.
20. **Fiscal numbers are gap-free and issued at finalisation**, in the same transaction that freezes the document. A draft has no number; a voided document keeps its number (`SCHEMA.md` §6.1).
21. **One pricing function.** `resolvePrice(item, scheme, serviceDate)` is the only place a price is chosen. An item missing from a payer's price list is **not covered**; it never falls back to the cash price on a payer's bill.
22. **Typed foreign keys plus `CHECK (num_nonnulls(...) = 1)`**, never a polymorphic `source_type` / `source_id` pair: a polymorphic reference cannot carry a composite foreign key, which is one of the four tenancy layers. Listed exceptions: `audit_log` and `outbox`, which record a subject id without a foreign key and hold no money.
23. **One lock order**, documented once: encounter → charges (by id) → payment → invoices (by id) (`SCHEMA.md` M8). New code that locks money rows follows it.
24. **Segregation of duties.** Refunds, write-offs, waivers, price changes and claim withdrawals record `requested_by` and `approved_by`, and `approved_by <> requested_by` is enforced by a `CHECK` as well as in the service.
25. **Clinical acts record the acting practitioner's membership** at the moment of the act, and that membership carries the cadre and licence number. A claim or a controlled-drug entry must be able to name a licensed person.
26. **Business dates are computed in Africa/Nairobi in one module.** Service dates, bed-day dates, number-series periods and report days never use the server's clock zone.
27. **Sensitive categories** (HIV, mental health, gender-based violence) need tighter access than the rest of the record. In v1 that is **break-glass**: opening a sensitive record outside the user's normal role requires a stated reason, writes an audit entry, and alerts the record owner (`SPEC.md` D5). Ward and department scoping come later.

---

## 4. Multi-tenancy and roles

Shared schema, shared database, `facility_id` discriminator. Isolation lives in Postgres, not in application discipline. Same four layers as the school SaaS:

1. **Three database connections.** The owner connection is for migrations, the test harness, tenant bootstrap, and the superadmin plane. The app connects as an unprivileged role (created with `NOBYPASSRLS`). The table owner is exempt from RLS, so an app connected as the owner has policies that exist and do nothing. Better Auth connects as a third unprivileged role, the only one that can read sessions, password hashes and verification tokens; it holds nothing on tenant tables, and the app role sees only `user (id, name, email)`. The API refuses to start if either unprivileged role is a superuser or holds `BYPASSRLS`. Verify this on whichever host runs production by running the RLS tests against it before real data goes in. Managed hosts restrict superuser rights differently, so the role setup in `db/roles.sql` may need adjusting per host.
2. **A transaction per tenant request.** Set the tenant with `set_config('app.facility_id', ..., true)` (transaction-scoped) so it cannot leak to the next borrower of a pooled connection.
3. **Policies on every tenant table**, `USING` and `WITH CHECK`, with `ENABLE` and `FORCE ROW LEVEL SECURITY`. No tenant set means zero rows.
4. **Composite foreign keys** `(facility_id, id)` on tenant-to-tenant references, since RLS does not constrain foreign keys.

**Choosing the facility.** The hostname never selects a tenant (`SPEC.md` §2). Every tenant request carries an `X-Facility-Id` header. `withFacility` sets it with `set_config`, then loads the facility and the caller's active membership on the tenant transaction, so RLS itself limits what it can see. No such membership is a 404, so a stranger cannot tell whether a facility exists; a suspended facility is a 403. `GET /me/facilities` lists the caller's own memberships for the facility picker. A header, not a session field, so a request queued offline still names the facility it was made in.

Roles come from memberships, not the global user. One membership per person per facility holds a set of roles:

| Area | Roles |
|---|---|
| Administration | `facility_admin`, `auditor` (read-only) |
| Front desk and records | `records_clerk` |
| Clinical | `doctor`, `clinical_officer`, `nurse`, `ward_nurse` |
| Lab | `lab_tech`, `lab_supervisor` |
| Pharmacy and stores | `pharmacist`, `pharm_tech`, `storekeeper` |
| Money | `cashier`, `billing_clerk`, `claims_officer`, `finance_manager` (approver for rule 24) |

A separate superadmin plane onboards facilities and works across tenants.

---

## 5. Reuse map

Most of the foundation already exists in school-saas-api (`../school-saas-api`). Port it with `school_id` → `facility_id`; do not reinvent it.

| Need | Source in school-saas-api |
|---|---|
| Tenant transaction middleware | `src/middlewares/tenant.ts` (`withTenant`, `withMembership`), resolving from the membership instead of the subdomain (`subdomain.ts` is not ported) |
| Owner vs app connection | `src/db/index.ts`, `db/roles.sql` |
| RLS migration pattern | `src/db/migrations/0002_tenant_rls.sql` |
| Guard tests | `src/db/db-access.test.ts`, `src/db/rls.test.ts`, `src/db/enum-checks.test.ts` |
| Role checks | `src/middlewares/auth.ts` (`requireMembershipRole`) |
| Audit | `src/lib/audit.ts` (`recordAudit`) |
| Allocations, balances | `src/lib/allocations.ts`, `src/lib/balances.ts` |
| M-Pesa C2B, per-tenant credentials | `src/lib/mpesa-c2b.ts`, `src/lib/crypto.ts`, the reconciliation routes |
| M-Pesa STK push | `src/lib/mpesa.ts` (dormant client) |
| Immutability triggers | `mpesa_transactions_immutable()` in `0006_mpesa_c2b.sql`, `report_cards_snapshot_frozen()` in `0007` |
| Rate limiting, env, client IP | `src/middlewares/rate-limit.ts`, `src/env.ts`, `src/lib/client-ip.ts` |
| Test harness | `src/test/helpers.ts` (`resetDb`, factories, `backendPid`, `waitForBlockedBackend`), `src/test/global-setup.ts` |
| Printed-document verification | `src/lib/verification.ts` |
| Email (Resend), SMS (Africa's Talking) | `src/lib/email.ts`, `src/lib/sms.ts`; keep each behind its interface so the provider can change in one file |
| Phones, dates, DB errors | `src/lib/phone.ts`, `src/lib/dates.ts`, `src/lib/db-errors.ts` |
| CI, Docker | `.github/workflows/ci.yml`, `Dockerfile`, `docker-compose.yml` (use ports 5438/5439/6383 here) |

From tour-api, take the **design only** (it is JavaScript on Express): one structure carrying money in both directions, "settled is derived from allocations, never status", and an outbox that stores an operation and subject id and replays by re-reading current state.

Gaps to fill, because school-saas never needed them: number series for fiscal documents, PDF rendering, background jobs and the outbox, pino redaction, an in-memory rate-limit fallback, read auditing.

---

## 6. Domain model outline

The detail is in `SCHEMA.md`. In short:

- **Encounter-centred:** patient → encounter (OPD visit, admission, or emergency) → observations, notes, diagnoses, orders, results, dispenses, charges. Names loosely aligned with FHIR resources; a FHIR API is not required for v1.
- **Money moves at four levels:** charge → invoice → claim → remittance. Each level has its own invariants (`SCHEMA.md` §7.6, M1–M8).
- **Payers:** SHA and insurers are payers with schemes; a patient's coverages become an encounter's billing plan in priority order. A rejected claim amount moves by adjustment document, never by editing charges.
- **Patient numbers** are auto-generated sequentially per facility from a counter row, with a facility-chosen prefix. The same counter issues gap-free fiscal document numbers.
- **Printed documents** go through `documents` (`SCHEMA.md` §6.2). The module that finalises the work calls `issueDocument` in that transaction: it takes the number, mints the QR verification code and freezes exactly what is printed. A PDF is rendered from that frozen content only, and every opening is audited. Never print a document from live rows.
- **Pharmacy and stores:** shared drug catalogue (identity only); per-facility inventory items with the facility's own cost and selling prices; batch-level stock per store; first-expiry-first-out dispensing; every movement is a stock ledger entry.
- **Prices** are per facility and per payer price list. Only `facility_admin` and `finance_manager` change them, and each change is audited with old and new values.
- **Units of sale** (loose units vs packs) are an open question. Do not fix the stock unit model until it is answered.

---

## 7. Operational rules

**Rate limiting.** Separate limits for login, patient search (to deter record scraping), and export endpoints, keyed per user, per facility, and per IP. Keys use IDs and hashed IPs only. Use an in-memory limiter as a first layer and as a fallback if Redis is unreachable. Decide fail-open vs fail-closed per route. Redis holds counters only: no patient data and no job queues.

**Outbox and external calls.** Every call to SHA, an insurer, Daraja, SMS or email is an outbox row written in the business transaction (rule 18). A worker claims it, calls out, and records the result in `gateway_exchanges` in a new transaction. Handlers re-read current state rather than trusting a payload, and are idempotent.

**Background jobs.** Cloud Tasks for one-off jobs (reminders, outbox drains), Cloud Scheduler for recurring jobs. Workers are internal routes authenticated with Google-signed identity tokens, never public. Handlers must be idempotent (delivery is at-least-once); use deterministic task names such as `reminder-{appointmentId}-24h`. Payloads carry IDs only. Check current state at run time instead of trying to cancel tasks. An outbox job that gives up is marked `failed` with its `last_error`, and logged as `outbox job failed permanently` for alerting. Other jobs record permanent failures in `job_failures`, which arrives with the first of them (the nightly bed-day accrual, P2). Outbox jobs queued inside `runAsFacility` (or `nudgingAfterCommit`) are nudged by a Cloud Task once the transaction commits; never create a task inside one (rule 18).

| Job | Trigger | Action |
|---|---|---|
| Bed-day accrual | Scheduler, nightly | Fan out per facility; run the idempotent bed-day function (`SCHEMA.md` §7.2) |
| Outbox drain | Cloud Tasks on write, plus a Scheduler sweep | Deliver pending external calls |
| Appointment reminder | Cloud Tasks, scheduled at booking | Verify the appointment is still valid, send SMS |
| Expiry scan, low stock | Scheduler, nightly | Fan out per facility; flag batches nearing expiry and items below reorder level |
| Reconciliation check | Scheduler, daily | Check identities M7 per facility; alert on drift |
| Daily report | Scheduler, daily | Fan out per facility; generate the summary |

**File storage.** One bucket per environment, not per facility. Tenant-prefixed random keys, e.g. `tenants/{facilityId}/patients/{patientId}/{uuid}`. Public access prevention on, uniform bucket-level access, versioning and soft delete on, Data Access audit logs on. Sign URLs via the service account's IAM `signBlob` permission, not key files. Validate file type and size; strip image EXIF data; scan external documents. Keep all access behind a small storage interface (`put`, `get`, `createSignedUrl`, `delete`): `src/lib/storage.ts`, with `newObjectKey` for keys and `src/lib/object-storage.ts` for the configured driver. Bucket location cannot be changed after creation.

---

## 8. Local development and environments

- Docker Postgres with separate dev and test databases, plus Docker Redis, as in the school SaaS. Ports: **5438** dev Postgres, **5439** test Postgres, **6383** Redis, bound to `127.0.0.1`. The sibling projects already use 5432–5437 and 6381–6382.
- For storage, use a local implementation of the storage interface (or `fake-gcs-server` in Docker with `STORAGE_EMULATOR_HOST`). The emulator may not enforce signed URL signatures, so test permission checks at the API layer.
- `PayerGateway` and Daraja have test doubles; no test or seed reaches SHA, an insurer, Safaricom, or an SMS provider.
- **Synthetic data only** in dev and staging. Seed data must never send real SMS.
- **Staging runs on the same kind of host as production**, so differences in roles, extensions and limits show up before go-live rather than at it.

---

## 9. Compliance constraints that affect code

Verify these with a lawyer, the regulator or DHA/SHA. They are noted here so code does not paint you into a corner.

- Health data is sensitive personal data under the Data Protection Act 2019. Expect consent handling, audit trails, and localization rules that may constrain where data is stored and processed.
- The Digital Health Act 2023 and the Digital Health (Health Information Management Procedures) Regulations 2025: this product must be **certified by DHA** before any facility can use it for SHA. Prerequisites include ODPC registration, a DPIA, and encryption at rest and in transit. Each facility is then connected through AfyaConnect to the national registries and the health information exchange. Code that touches security, data exchange or reporting feeds the certification pack (`ROADMAP.md` §1, `SPEC.md` §8).
- The Social Health Insurance Act 2023 and SHA (which replaced NHIF in October 2024): funds, benefit packages, tariffs, preauthorization and claims rules shape the payer model. Treat every operational detail as "verify".
- The Pharmacy and Poisons Act (Cap 244) has Poisons Book and dispensing provisions. Exact hospital obligations are still to be confirmed.
- The DHA's Kenya ePrescription Implementation Guide (a draft at last check) defines a controlled-substance schedule extension and uses PPB terminology. Consider seeding the drug catalogue from it.
- KRA eTIMS: whether and how it applies to a hospital's invoices waits on a tax adviser's answer (`SPEC.md` D7).

---

## 10. Open questions

See `SPEC.md` sections 4 and 5. Do not resolve these in code without asking:

- Data residency, and therefore the production database host, region, and bucket location
- Loose units vs full packs for dispensing
- Pilot hospital
- Medical-records retention requirements
- PPB dispensing record obligations
- ICD-10 vs ICD-11 for diagnoses and claims
- What DHA certification requires of this product (classification, whether clinical modules are judged, cost, re-certification)
- eTIMS (D7 is decided as "follow the tax adviser"; the answer is not in yet)

Design decisions D1–D8 are settled (`SPEC.md` §5). Follow them; raise a concern rather than quietly deviating.
