# CLAUDE.md

Project context for AI assistants working in this repository. Read this before writing code.

`SPEC.md` is the source of truth for decisions and open questions. This file holds the conventions that code must follow. Conventions were adapted from the school management SaaS and extended for health data. Where a choice is not yet decided, this file says so. **Do not silently decide an open item; ask.**

---

## 1. What this is

A multi-tenant healthcare management SaaS for small and mid-size private clinics in Kenya. Sold to many clinics. Each clinic is a tenant.

**In scope for v1:**

- Patient records (multiple identifiers per patient)
- Walk-in queue and appointments
- Consultations: vitals, ICD-10 diagnoses, notes, printable prescriptions
- Billing: invoices, receipts, cash and M-Pesa
- Pharmacy inventory: shared drug catalogue, per-clinic stock and prices, dispensing
- Basic reports (daily revenue, patient counts, stock status)

**Out of scope for v1** — do not build these unless asked:

- Lab, inpatient, telehealth
- SHA and insurance claims submission (design for it, do not build it)

The design must leave room for SHA and insurance later without rewrites. See the payer rule in section 3.

---

## 2. Stack

| Layer | Choice | Status |
|---|---|---|
| Hosting | Google Cloud Run | Confirmed (initially) |
| Database | Neon (serverless Postgres) to start; production host decided later | Confirmed for now |
| Local dev/test | Docker Postgres (separate dev and test databases) + Docker Redis | Confirmed (same pattern as the school SaaS) |
| Redis in production | Upstash Redis | Confirmed |
| Rate limiting | Redis-backed; `rate-limiter-flexible` assumed, as in the school SaaS | Library to be confirmed |
| File storage | Google Cloud Storage | Confirmed |
| Backend | Hono + `@hono/zod-openapi`, Drizzle ORM | Proposed |
| Frontend | Next.js, built as a PWA | Proposed |
| Auth | Better Auth | Proposed |
| Payments | Safaricom Daraja (M-Pesa) | Proposed |
| Email / SMS | Resend / an SMS provider for reminders | Proposed |
| Background jobs | Cloud Tasks + Cloud Scheduler | Proposed |

Not yet decided: tenant resolution (subdomain vs other), production database host and region, storage bucket location. All three depend on the data residency question in `SPEC.md`.

---

## 3. Non-negotiable conventions

These are load-bearing. Do not deviate without discussion.

1. **`clinicId` on every tenant table**, even where it is derivable through a foreign key. RLS policies and the tenant guard depend on it.
2. **Never query the raw owner `db` from a route handler.** Use `c.get('db')`, the per-request tenant transaction (section 4). A test should fail the build on a stray import.
3. **Money is integer cents** (KES), never floats. Field names end in `Cents`.
4. **Balances and stock quantities are derived**, never stored: invoices minus payments for money; the stock ledger for inventory.
5. **Nothing hard-deletes.** Patients, visits, notes, prescriptions, invoices, payments, and stock movements are only status-transitioned or reversed. The runtime role holds no `DELETE` on domain tables. Any exception must be listed explicitly here.
6. **Every invoice has a payer** (self-pay now; SHA or a private insurer later). This is what makes claims an addition rather than a rewrite.
7. **Snapshot what is printed or billed.** Invoice lines copy the price at the time of sale; receipts and prescriptions freeze at finalisation. A later price change must never alter a past invoice.
8. **Store coded clinical data**: ICD-10 for diagnoses and catalogue codes for services and drugs, not only free text. Claims and reporting need them.
9. **Audit reads as well as writes.** `audit_log` is append-only, written inside the same transaction as the action. The runtime role holds `INSERT` and `SELECT` only. Record who *viewed* a patient record or document, not just who changed one.
10. **No patient data outside the database.** No names, phone numbers, national IDs, diagnoses, or clinical details in logs, Redis keys, queue payloads, URLs, or file names and object keys. Use IDs only.
11. **Files: store the object key, never a URL.** The bucket comes from environment config. Access is a permission check, then an audit entry, then a short-lived signed URL. Never persist signed URLs.
12. **Controlled drugs carry a flag and a schedule (I–IV).** Dispensing them writes to a separate register (patient, prescriber, quantity, running balance) and is limited to authorized roles.
13. **Phone numbers stored E.164** (`+2547...`). Normalise on write.
14. **Dates are `date`; instants are `timestamp`.**
15. **A `.$type<"a" | "b">()` text column carries a matching `CHECK`.** The type constrains this codebase and nothing else; a seed or hand-run correction can put any value in a text column, and the failure is silent (rows stop matching filters). Enforce with a test, as in the school SaaS.

---

## 4. Multi-tenancy

Shared schema, shared database, `clinic_id` discriminator. Isolation lives in Postgres, not in application discipline. Same four layers as the school SaaS:

1. **Two database connections.** The owner connection is for migrations, the test harness, tenant bootstrap, and the superadmin plane. The app connects as an unprivileged role (created with `NOBYPASSRLS`). The table owner is exempt from RLS, so an app connected as the owner has policies that exist and do nothing. Verify this on Neon by running the RLS tests against it.
2. **A transaction per tenant request.** Set the tenant with `set_config(..., true)` (transaction-scoped) so it cannot leak to the next borrower of a pooled connection.
3. **Policies on every tenant table**, `USING` and `WITH CHECK`, with `ENABLE` and `FORCE ROW LEVEL SECURITY`. No tenant set means zero rows.
4. **Composite foreign keys** `(clinic_id, id)` on tenant-to-tenant references, since RLS does not constrain foreign keys.

Roles come from memberships, not the global user: proposed roles are doctor, nurse, receptionist, pharmacist, admin. A separate superadmin plane onboards clinics and works across tenants.

---

## 5. Domain model outline (proposed; no schema yet)

- **Visit-centered:** patient → visit → vitals, notes, diagnoses, orders, prescriptions, invoice. Names loosely aligned with FHIR resources; a FHIR API is not required for v1.
- **Patients** carry multiple identifiers (national ID, phone, later an SHA number).
- **Patient numbers** are auto-generated sequentially per clinic from a counter row, with a clinic-chosen prefix. The OP number is issued at registration; the IP number is issued once per patient and linked to it. See `SCHEMA.md`.
- **Pharmacy:** a shared drug catalogue (identity only: generic name, brand, strength, form, unit); per-clinic inventory items referencing it, each with the clinic's own cost and selling price; stock tracked by batch (number, expiry, quantity, cost); dispensing first-expiry-first-out; every receipt, dispense, adjustment, and write-off is a stock ledger entry.
- **Prices** are per clinic. Only owner and admin roles change them, and each change is audited with old and new values.
- **Units of sale** (loose units vs packs) are an open question. Do not fix the stock unit model until it is answered.
- **Flow:** prescription → dispense (deducts stock) → invoice line.

---

## 6. Operational rules

**Rate limiting.** Separate limits for login, patient search (to deter record scraping), and export endpoints, keyed per user, per clinic, and per IP. Keys use IDs and hashed IPs only. Use an in-memory limiter as a first layer and as a fallback if Redis is unreachable. Decide fail-open vs fail-closed per route. Redis holds counters only: no patient data and no job queues.

**Background jobs.** Cloud Tasks for one-off jobs (reminders), Cloud Scheduler for recurring jobs (expiry scan, low-stock alerts, daily report). Workers are internal routes authenticated with Google-signed identity tokens, never public. Handlers must be idempotent (delivery is at-least-once); use deterministic task names such as `reminder-{appointmentId}-24h`. Payloads carry IDs only. Check current state at run time instead of trying to cancel tasks. Record permanent failures in a Postgres table for alerting and re-runs.

**File storage.** One bucket per environment, not per clinic. Tenant-prefixed random keys, e.g. `tenants/{clinicId}/patients/{patientId}/{uuid}`. Public access prevention on, uniform bucket-level access, versioning and soft delete on, Data Access audit logs on. Sign URLs via the service account's IAM `signBlob` permission, not key files. Validate file type and size; strip image EXIF data; scan external documents. Keep all access behind a small storage interface (`put`, `get`, `createSignedUrl`, `delete`). Bucket location cannot be changed after creation.

---

## 7. Local development and environments

- Docker Postgres with separate dev and test databases, plus Docker Redis, as in the school SaaS.
- For storage, use a local implementation of the storage interface (or `fake-gcs-server` in Docker with `STORAGE_EMULATOR_HOST`). The emulator may not enforce signed URL signatures, so test permission checks at the API layer.
- **Synthetic data only** in Neon, dev, and staging until the residency question is settled. Seed data must never send real SMS.

---

## 8. Compliance constraints that affect code

Verify these with a lawyer or the regulator; they are noted here so code does not paint you into a corner.

- Health data is sensitive personal data under the Data Protection Act 2019. Expect consent handling, audit trails, and localization rules that may constrain where data is stored and processed.
- The Pharmacy and Poisons Act (Cap 244) has Poisons Book and dispensing provisions. Exact clinic obligations are still to be confirmed.
- The Digital Health Agency's Kenya ePrescription Implementation Guide (a draft at last check) defines a controlled-substance schedule extension and uses PPB terminology. Consider seeding the drug catalogue from it.

---

## 9. Open questions

See `SPEC.md` section 4. Do not resolve these in code without asking:

- Data residency, and therefore the production database host, region, and bucket location
- Loose units vs full packs for dispensing
- Pilot clinics
- Medical-records retention requirements
- PPB dispensing record obligations
- Tenant resolution (subdomain vs other)
