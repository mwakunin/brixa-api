# Healthcare Management System (Clinic SaaS) — Project Spec

Status: early scoping · Last updated: 2026-09-21

This document separates what has been **decided** from what is only **proposed** and what is still **open**. Update the status of items as they are settled.

---

## 1. Overview

A multi-tenant SaaS for small and mid-size private clinics in Kenya. The first version is a lightweight tool covering patient records, appointments, consultations, prescriptions, billing, and pharmacy inventory. The design must leave room to expand later into SHA claims, private insurance, and other modules without rewrites.

---

## 2. Decisions (confirmed)

- **Target customer:** small and mid-size private clinics.
- **Core scope:** patient records, appointments, consultations, prescriptions, billing.
- **Pharmacy inventory:** in scope, with drug prices stored for reference. Prices are **each clinic's own selling prices** (not a shared reference price list).
- **Future expansion:** SHA, insurance, and similar payer integrations.
- **Rate limiting:** Redis, using **Upstash Redis in production**.
- **Hosting:** Google Cloud Run initially.
- **Database (to start):** Neon (serverless Postgres). The production database host is decided later.
- **Local dev/test:** Docker Postgres (separate dev and test databases) and Docker Redis, the same pattern as the school management SaaS.
- **File storage:** Google Cloud Storage. Decided now because it affects code.
- **Patient numbers:** auto-generated and sequential per clinic, with a clinic-chosen prefix (e.g. `OP` for outpatient, `IP` for inpatient). The IP number is issued once per patient and linked to their OP number. See `SCHEMA.md`.

---

## 3. Proposed (not yet confirmed)

| Area | Proposal |
|---|---|
| Backend | Hono + `@hono/zod-openapi`, Drizzle ORM |
| Database | PostgreSQL with tenant isolation via row-level security. Neon to start; production host and region TBD (see open questions) |
| Frontend | Next.js, built as a PWA for connectivity drops at the front desk |
| Auth | Better Auth with clinic-level organizations and role-based permissions |
| Payments | M-Pesa Daraja (STK push) for patient payments |
| Messaging | Email via Resend; SMS provider for appointment reminders |
| File storage design | Private bucket behind a small storage interface (provider decided: Google Cloud Storage) |
| Background jobs | Cloud Tasks (one-off) and Cloud Scheduler (recurring) |
| Rate limiting library | `rate-limiter-flexible` |

---

## 4. Open questions

1. **Hosting region and data residency.** As far as known, Google Cloud has no Kenya region (nearest is Johannesburg). Confirm with a lawyer whether the localization rules for health data require in-country storage. This decides the database and storage provider.
2. **Loose units vs full packs.** Do target clinics dispense individual units (e.g., single tablets)? If yes, items need a pack size and base unit, with stock tracked in the base unit.
3. **Pilot clinics.** Are 2–3 pilot clinics lined up? Workflows differ between general outpatient, dental, and maternity clinics.
4. **Production database host.** Neon is used to start. Choose the production host and region once question 1 is settled. Recommendation: synthetic or demo data only in Neon until then.
5. **Storage bucket location.** GCS is the chosen provider. A bucket's location cannot be changed after creation (moving means creating a new bucket and copying objects), so choose the production location after question 1.
6. **Records retention.** Confirm medical-records retention requirements before setting storage lifecycle rules.
7. **PPB dispensing obligations.** Confirm what a clinic dispensary must record under the Pharmacy and Poisons Act (Cap 244), including the Poisons Book provisions.

---

## 5. MVP scope

**In:**

- **Patients:** registration and search; multiple identifiers per patient (national ID, phone, later an SHA number).
- **Queue and appointments:** a walk-in queue view (often more important than formal booking in small clinics) plus appointments.
- **Consultation:** vitals, diagnosis (ICD-10), notes, printable prescriptions.
- **Billing:** invoices, receipts, M-Pesa and cash.
- **Pharmacy inventory:** catalogue, batches, stock ledger, dispensing, alerts, prices.
- **Reports:** daily revenue, patient counts, stock status.

**Deferred:** lab, inpatient, telehealth, SHA and insurance claims submission.

---

## 6. Architecture principles

### 6.1 Multi-tenancy
- `tenant_id` on every tenant-owned row, enforced with row-level security.
- Users belong to a clinic and hold a role: doctor, nurse, receptionist, pharmacist, admin.

### 6.2 Data model
- Visit-centered: patient → visit → vitals, notes, diagnoses, prescriptions, invoice.
- Loosely aligned with FHIR resource naming. A FHIR API is not required for the MVP.
- Store coded data from day one: ICD-10 for diagnoses and catalogue-coded services. Claims and reporting need these, and back-filling is painful.

### 6.3 Billing (built for later payers)
- Invoices consist of line items from a service catalogue.
- Every invoice has a **payer** (self-pay now; SHA or private insurer later). Claims then become a new payer type and workflow, not a redesign.
- Invoice lines **snapshot the price at the time of sale**, so later price changes never alter past invoices.

### 6.4 Pharmacy inventory
- **Shared drug catalogue** (generic name, brand, strength, form, unit) maintained centrally. Consider seeding from the PPB terminology used by the Digital Health Agency's ePrescription guide.
- **Per-clinic inventory items** reference a catalogue entry and carry the clinic's own cost price and selling price.
- **Batch-level stock:** batch number, expiry date, quantity, cost price. Dispense first-expiry-first-out. Generate expiry and low-stock alerts.
- **Stock ledger:** every receipt, dispense, adjustment, and write-off is an entry; current stock is derived. Supports audit and stock-take reconciliation.
- **Prices:** cost and selling price kept separate. Optional default markup percentage per category, overridable per item. Only owner/admin roles can change prices; changes are audited with old and new values.
- **Controlled substances:** catalogue items carry a controlled flag and schedule (I–IV). Dispensing these writes to a separate register (patient, prescriber, quantity, running balance) and is restricted to authorized roles.
- **Flow:** prescription → dispense (deducts stock) → invoice line.
- **Onboarding:** CSV import of an existing drug list and prices, mapped to the shared catalogue.
- **Units:** pending open question 2.

### 6.5 Security and audit
- Role-based access control.
- Append-only audit log of who viewed or changed each record, written by the application at the point access is granted.
- Encryption in transit and at rest; encrypted backups.
- Easy data export for clinics (avoids lock-in concerns).

### 6.6 File storage
- Private bucket with public access prevention enforced; no public URLs for patient documents.
- API checks permission, writes an audit entry, then returns a short-lived signed URL.
- Metadata (tenant, patient, visit, type, checksum, uploader, object key) lives in Postgres.
- Object keys are tenant-prefixed with random names, e.g. `tenants/{tenantId}/patients/{patientId}/{uuid}`. No patient names in paths.
- Validate file type and size, strip image EXIF data, add virus scanning for external documents (e.g., upload to a quarantine bucket, scan, then move).
- Enable object versioning and soft delete.
- Enable Cloud Storage Data Access audit logs (off by default).
- Sign URLs via the service account's IAM `signBlob` permission, not key files.
- Keep all storage access behind a small interface (`put`, `get`, `createSignedUrl`, `delete`) so the provider can change.

### 6.7 Rate limiting
- `rate-limiter-flexible` with Upstash Redis in production.
- Separate limits for login, patient search (to deter record scraping), and export endpoints, keyed per user, per clinic, and per IP.
- Keys use user IDs, clinic IDs, and hashed IPs only. **Never** phone numbers, national IDs, or patient names.
- Use an in-memory limiter as a fast first layer and as fallback if Redis is unreachable. Decide fail-open vs fail-closed per route (general endpoints fail open; login and export stay strict).
- Redis holds counters only. No patient data, no job queues.
- Costs: Upstash pay-as-you-go is per command; consider a fixed plan once volume is steady. Keep the connection string in Secret Manager and reuse one client per Cloud Run instance.
- Measure round-trip latency between the Cloud Run region and the Upstash region.

### 6.8 Background jobs
- **Cloud Tasks** for one-off jobs (e.g., appointment reminders); **Cloud Scheduler** for recurring jobs.
- Workers are internal routes on the API (or a separate Cloud Run service), authenticated with Google-signed identity tokens and never public.
- Handlers must be **idempotent** (delivery is at-least-once). Use deterministic task names such as `reminder-{appointmentId}-24h` to reject duplicates.
- Payloads carry IDs only, never names, phone numbers, or clinical details.
- Check current state at run time (e.g., appointment still confirmed) instead of trying to cancel tasks.
- Record permanent failures in a Postgres table for alerting and re-runs.
- Keep the queue and Cloud Run in the same region.

Planned MVP jobs:

| Job | Trigger | Action |
|---|---|---|
| Appointment reminder | Cloud Tasks, scheduled at booking | Verify appointment still valid, send SMS |
| Expiry scan | Cloud Scheduler, nightly | Fan out one task per clinic; flag batches nearing expiry |
| Low-stock alert | Cloud Scheduler, nightly | Fan out per clinic; flag items below reorder level |
| Daily clinic report | Cloud Scheduler, daily | Fan out per clinic; generate summary |

---

## 7. Compliance notes (verify with a lawyer or the regulator)

- **Data Protection Act 2019:** health data is sensitive personal data. Expect ODPC registration, consent handling, and audit trails. The data protection regulations also contain localization rules that can affect where health data is processed and stored.
- **Digital Health Act and Digital Health Agency:** Kenya is moving toward a national health information exchange. Aligning with FHIR-style models and the DHA's Kenya ePrescription Implementation Guide (a draft, version 0.1.0 continuous build at last check) will ease later integration. The guide defines an extension for marking a medication as controlled and giving its schedule (I–IV).
- **Pharmacy and Poisons Act (Cap 244):** contains provisions on a Poisons Book and on the supply and dispensing of Part I poisons by doctors and hospitals. The exact clinic obligations still need to be confirmed with PPB.
- **SHA:** claims, preauthorization, and reconciliation are the main later value drivers; billing and coding are designed to accommodate them.

---

## 8. Commercial notes

- Per-clinic monthly subscription, tiered by number of users.
- Paid onboarding, data migration, and staff training.
- Pilot with 2–3 clinics before generalizing across clinic types.
