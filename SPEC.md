# Hospital Management System (Hospital SaaS) — Project Spec

Status: scoping · Last updated: 2026-11-04

This document separates what has been **decided** from what is only **proposed** and what is still **open**, and records the design decisions taken (§5) with their reasoning. Update the status of items as they are settled. `CLAUDE.md` holds the coding conventions, `SCHEMA.md` the data model, and `ROADMAP.md` the order of work.

---

## 1. Overview

A multi-tenant SaaS for private and mission hospitals in Kenya, designed first for **Level 4 hospitals** (roughly 20–150 beds: outpatient, wards, lab, pharmacy and stores). The first version covers patient records, queues and appointments, outpatient and inpatient care, lab, pharmacy and stores, billing, and **SHA and private-insurer claims**.

The earlier scoping (2026-09-21) targeted small outpatient clinics, with inpatient, lab and claims deferred. That target was replaced on 2026-11-03. A hospital's revenue depends on payers, so claims moved into v1, and the money model was redesigned for payer splits (`SCHEMA.md` §7).

**SHA claims require DHA certification.** Since mid-2026, SHA contracts only facilities that use a DHA-certified HMIS connected to the national platforms, and the SHA Provider Portal (manual claims) is being shut down (§8). Two consequences shape this plan:

- This product cannot carry a single SHA claim until it is certified. Certification is on the critical path, not a final step (`ROADMAP.md`).
- By the time this product is certified, every SHA-contracted private hospital will already be on one of the certified systems. Selling to them means **replacing an incumbent**, so migration from the main incumbent systems is a v1 feature, and the product has to beat what hospitals already run (§11).

---

## 2. Decisions (confirmed)

- **Target customer:** Level 4 private and mission hospitals. *(Changed 2026-11-03; was small and mid-size private clinics.)*
- **Tenancy:** one tenant = **one facility** (its own KMHFR code and SHA contract). A hospital group's branches are separate tenants for now; group features come later. *(2026-11-03)*
- **Scope of v1:** patient records, queues and appointments, OPD consultations, lab, inpatient, pharmacy and stores, billing, reports, and **SHA and private-insurer claims** (eligibility, preauthorization, claims, remittances). *(2026-11-03)*
- **Cashier channels in v1:** cash (with cashier shifts), card and bank (recorded with a reference, no terminal integration), M-Pesa paybill (C2B), M-Pesa STK push. *(2026-11-03)*
- **Pilot:** a candidate identified 2026-11-03, not yet confirmed. Its situation:
  - a newly opened private hospital, cash-only today, planning to add insurers and SHA later;
  - it runs an HMIS whose vendor says it is DHA-certified (check it on DHA's register);
  - staff find that system **too involved and complex for ordinary users**. That complaint is the reason to switch, and the reason simplicity is a product principle (§7.9).

  Identifying details (the hospital and its current vendor) stay out of this repository, in `PRIVATE-NOTES.md`, which git ignores.
- **Design decisions D1–D8:** taken 2026-11-03 (§5).
- **Pharmacy inventory:** in scope. Prices are **each facility's own selling prices** (not a shared reference price list), plus payer price lists.
- **Rate limiting:** Redis, using **Upstash Redis in production**.
- **Hosting:** Google Cloud Run initially.
- **Database:** PostgreSQL. Development and tests run on local Docker Postgres. Production and staging share one host, chosen by the residency answer (question 4). Neon is dropped: it has no African region, and the API and database must sit in the same region. PocketBase (SQLite, no row-level security) and Supabase (duplicates the auth, storage and API layers already chosen) were considered and rejected. *(2026-11-03)*
- **PDF rendering:** pdfmake. A printed document's frozen data is the source of truth; the PDF is rendered from it. *(2026-11-03)*
- **Local dev/test:** Docker Postgres (separate dev and test databases) and Docker Redis, the same pattern as the school management SaaS.
- **File storage:** Google Cloud Storage. Decided now because it affects code.
- **Email and SMS:** Resend for email and Africa's Talking for SMS, both reusing the school SaaS's code, each behind a small interface so the provider can change in one file. Brevo (email, SMS and WhatsApp in one account) is the option to revisit if WhatsApp reminders are wanted. *(2026-11-03)*
- **Patient numbers:** auto-generated and sequential per facility, with a facility-chosen prefix (e.g. `OP` for outpatient, `IP` for inpatient). The IP number is issued once per patient and linked to their OP number. See `SCHEMA.md` §5–§6.
- **Backend stack:** Hono + `@hono/zod-openapi`, Drizzle ORM and Better Auth, with foundations ported from school-saas-api (`CLAUDE.md` §5). *(2026-11-03)*
- **Tenant resolution:** one web address for every facility; the facility comes from the signed-in user, not the hostname. A user with one membership goes straight in; a user with several picks the facility to work in, and can switch without signing in again. Every request is checked against an active membership inside the tenant transaction, before the handler runs (so a refused request still briefly holds an app connection). Subdomains were rejected: only staff use v1 (no patient portal), staff who work at two facilities (locums, branches of one group) would need a login per facility, a PWA installed on one origin would need a separate install and offline store per facility, and Cloud Run would need a wildcard certificate behind a load balancer. This does not depend on data residency. *(2026-11-03)*
- **Accounts are invite-only.** There is no public sign-up. A facility's first admin is invited when the facility is onboarded; that admin invites the rest of the staff. Login data (sessions, password hashes) sits behind its own database role, separate from the one tenant requests use. *(2026-11-03)*
- **OPD and lab (P3):** patients may pay at each point before the service (**pay as you go**) or once at the end (**bill at the end**), side by side and with no setting to choose between them: the cashier bills whatever is unbilled whenever the patient pays. A test not yet paid for shows a warning at the lab (none in an emergency visit) and never blocks the work. Lab tests are charged when ordered. Consultation fees are set per clinic. Any lab member other than the person who entered a result may verify it. Verified results print as a numbered lab report. Walk-in lab clients (an outside doctor's request) are served in P3. The slicing, the recommendations accepted with these, and what is still proposed are in `ROADMAP.md` P3. *(2026-11-10)*

---

## 3. Proposed (not yet confirmed)

| Area | Proposal |
|---|---|
| Database | PostgreSQL with tenant isolation via row-level security. Production host and region per question 4 |
| Frontend | Next.js, built as a PWA for connectivity drops at service points |
| Money model | Charge → invoice → claim → remittance, debtor accounts, allocations ported from school-saas (`SCHEMA.md` §7) |
| Payer integration | `PayerGateway`: a `manual` channel (claim packs, remittance import) for private insurers in P7; an `afyaconnect` channel for SHA through DHA's integration platform, built against the sandbox and live only after certification |
| External calls | Transactional outbox drained by Cloud Tasks workers |
| Payments | M-Pesa Daraja C2B per facility and STK push |
| File storage design | Private bucket behind a small storage interface (provider decided: Google Cloud Storage) |
| Background jobs | Cloud Tasks (one-off) and Cloud Scheduler (recurring) |
| Rate limiting library | `rate-limiter-flexible` |
| Phase order | Cash billing, then clinical modules, then the pilot goes live (P6); payers (P7) and certification (P8) after (`ROADMAP.md` §1) |

---

## 4. Open questions

1. **Hosting region and data residency.** As far as known, Google Cloud has no Kenya region (nearest is Johannesburg). Confirm with a lawyer whether the localization rules for health data require in-country storage. This decides the database and storage provider. Ask DHA too: HMIS certification may carry its own hosting requirements.
2. **Loose units vs full packs.** Do hospitals dispense individual units (e.g., single tablets)? If yes, items need a pack size and base unit, with stock tracked in the base unit.
3. **Pilot hospital.** A candidate exists (§2) but is not confirmed. Workflows differ between private, mission and faith-based hospitals, and between levels, so its size and departments shape the first release (§9).
4. **Production database host.** Decided by question 1. If hosting outside Kenya is allowed: **Cloud SQL for PostgreSQL in Johannesburg** (`africa-south1`), next to Cloud Run (confirm Cloud Run is offered there). If data must stay in Kenya: the API and Postgres both move to a Kenyan data centre or cloud, since no major cloud has a Kenya region. Staging uses the same host as production.
5. **Storage bucket location.** GCS is the chosen provider. A bucket's location cannot be changed after creation (moving means creating a new bucket and copying objects), so choose the production location after question 1.
6. **Records retention.** Confirm medical-records retention requirements before setting storage lifecycle rules.
7. **PPB dispensing obligations.** Confirm what a hospital pharmacy must record under the Pharmacy and Poisons Act (Cap 244), including the Poisons Book provisions.
8. **ICD-10 or ICD-11: ICD-11** *(decided 2026-11-10)*. DHA's [Claims Submission Guide](https://afyalink.dha.go.ke/claim-integration) says SHA requires ICD-11 codes on every claim, and DHA's FHIR guides (Kenya Core, ePrescription, eClaims) use ICD-11. No SHA circular or effective date was found. **Still open:** which intervention or procedure coding SHA uses.
9. **PHC capitation at Level 4.** Whether SHA's primary-care capitation applies at Level 4 and above. It is money not tied to any invoice, so it is deliberately not modelled until answered (`SCHEMA.md` §9).
10. **KRA eTIMS.** Whether a hospital's invoices must be transmitted through eTIMS even though medical services are VAT-exempt. See D7.
11. **What DHA certification requires of this product.** Which system classification to certify under; whether certification judges clinical modules (it almost certainly does, so certification follows the complete system); whether a billing-only classification exists; the cost, the certificate's validity, and whether each new release must be re-certified. Read regulations 36–43 of Legal Notice 76 of 2025 and DHA's certification guide in Phase 0 (§10).
12. **Can an uncertified system be used at all?** The 2025 regulations require certification for digital health solutions *used in providing healthcare*, not only for SHA claims. So a cash-only pilot running before certification may itself be non-compliant. Other vendors' systems are reportedly in use while "in the process" of certification, which suggests a transition arrangement, but that must be confirmed with DHA or a lawyer **before any pilot goes live** (§10, question 17).

---

## 5. Design decisions

All taken 2026-11-03. D1 and D8 were revised the same day, once it was clear that SHA's manual portal is closing (§8).

| # | Question | Decision |
|---|---|---|
| **D1** | What if DHA certification is slow? | There is **no manual SHA channel** to fall back on. While certification runs, lead with hospitals that are not SHA-contracted or have little SHA volume: they can run on this product for cash and private insurers. Partnering with an already-certified vendor is the fallback if certification stalls. Go/no-go at the Phase 0 gate (`ROADMAP.md`) |
| **D2** | May unit prices carry fractional shillings (e.g. KES 2.50 a tablet)? | **Yes for unit prices.** Each charge's amount is rounded to whole shillings once, at capture. Invoice totals, payments, allocations and refunds are whole shillings |
| **D3** | Snapshot a charge's price at capture or at billing? | **At capture.** Re-pricing is an explicit, audited act on unassigned charges only |
| **D4** | Default handling of amounts a payer disallows | **A policy per reason code.** Facility-caused reasons (coding errors, missing documents, late submission) default to **write-off**: the disallowance is absorbed as the facility's loss, with no second deduction (`SCHEMA.md` §7.5). Patient-caused reasons (not a member, limit exceeded, item not covered) default to **rebill to the patient**. Always approved by a second person (rule 24) |
| **D5** | Access model for sensitive records (HIV, mental health, GBV) | **v1: facility-wide roles, plus break-glass** for sensitive categories: state a reason, audit it, alert the record owner. Ward and department scoping later |
| **D6** | Is the facility the RLS boundary? | **Yes** (tenant = facility). Two branches of one group keep separate patient registers. Sharing patients across a group later needs a cross-facility patient index above the tenants, not a looser tenant |
| **D7** | eTIMS in v1? | **Decided by a tax adviser's answer in Phase 0.** Fiscal numbering (`SCHEMA.md` §6.1) and the outbox already leave room for an eTIMS gateway, so waiting costs little |
| **D8** | When does the pilot go live, and with what? | **As a complete cash hospital system in P6**, before payer billing (P7) and certification (P8). The pilot is a new, cash-only hospital that can only switch once it can leave its current system entirely. Insurer billing follows as it signs insurers; SHA follows certification, which must land before the hospital's planned SHA date. The lesson the school SaaS recorded still applies: put it in front of a real user before building further. *(Revised twice on 2026-11-03: first narrowed to cash and insurer billing, then reordered for the pilot.)* |

---

## 6. v1 scope

**In:**

- **Patients:** registration and search; multiple identifiers per patient (national ID, phone, SHA number, client-registry ID); OP and IP numbers.
- **Queues and appointments:** service-point queues (triage → consultation → lab → pharmacy → cashier) plus appointments with reminders.
- **OPD:** triage and vitals, ICD diagnoses, notes, orders, printable prescriptions.
- **Lab:** test catalogue, specimen accession, results entry, second-person verification.
- **Inpatient:** admissions, wards and beds, transfers, nursing notes, observation charts, medication administration record, discharge summaries.
- **Pharmacy and stores:** catalogue, stores and sub-stores, transfers, goods received, batches, stock ledger, FEFO dispensing, controlled-drug register, alerts, prices.
- **Billing:** charges captured at source, price lists per payer, payer-split invoices, deposits, refunds, waivers and credit notes, cashier shifts, receipts; cash, card, bank, M-Pesa C2B and STK push.
- **Payers and claims:** SHA and private insurers; coverages, eligibility checks, preauthorizations, claims and versions, remittances, disallowances.
- **Reports:** revenue and cashier summaries, debtors by payer, MOH 705A/705B and 717, stock status.

**Deferred:** see `ROADMAP.md` §3.

---

## 7. Architecture principles

### 7.1 Multi-tenancy
- `facility_id` on every tenant-owned row, enforced with row-level security (`CLAUDE.md` §4).
- Users belong to a facility through memberships and hold one or more roles (`CLAUDE.md` §4).
- The facility for a request comes from the signed-in user's chosen membership, not the hostname (§2, tenant resolution).

### 7.2 Data model
- Encounter-centred: patient → encounter (OPD visit, admission, emergency) → observations, notes, diagnoses, orders, results, dispenses, charges.
- Loosely aligned with FHIR resource naming. A FHIR API is not required for v1, but SHA/DHA exchanges may require FHIR payloads (verify).
- Store coded data from day one: ICD codes for diagnoses, intervention codes, catalogue-coded services and drugs, practitioner licence numbers. Claims and reporting need these, and back-filling is painful.

### 7.3 Billing and payers
- Money moves at four levels: **charge → invoice → claim → remittance** (`SCHEMA.md` §7).
- Charges are captured at source and priced by one function from the encounter's billing plan. An item missing from a payer's price list is not covered.
- Every money row belongs to a debtor account (patient or payer). Invoices are split by account, and a co-pay is a split of a charge.
- Deposits are payments held as credit on the patient's account; refunds return what payer cover leaves unused.
- Claims are immutable once submitted; corrections are new versions. A disallowed amount is one adjustment on the payer's invoice, then either rebilled or absorbed as a loss, never deducted twice.
- Invoice lines and charges **snapshot the price**, so later price changes never alter past bills.

### 7.4 Pharmacy and stores
- **Shared drug catalogue** (generic name, brand, strength, form, unit) maintained centrally. Consider seeding from the PPB terminology used by the Digital Health Agency's ePrescription guide.
- **Per-facility inventory items** reference a catalogue entry and carry the facility's own cost price and selling price; payer price lists add their own prices.
- **Stores:** a main store, the pharmacy, and ward and other sub-stores, with requested, approved and received transfers.
- **Batch-level stock:** batch number, expiry date, quantity, cost price. Dispense first-expiry-first-out. Generate expiry and low-stock alerts.
- **Stock ledger:** every opening balance, receipt, dispense, transfer, adjustment, return and write-off is an entry; current stock is derived per store and batch. Supports audit and stock-take reconciliation.
- **Prices:** cost and selling price kept separate. Optional default markup percentage per category, overridable per item. Only `facility_admin` and `finance_manager` change prices; changes are audited with old and new values.
- **Controlled substances:** catalogue items carry a controlled flag and schedule (I–IV). Dispensing these writes to a separate register (patient, prescriber, quantity, running balance) and is restricted to authorized roles.
- **Flow:** medication order → dispense (deducts stock, raises the charge) → invoice line.
- **Onboarding:** CSV import of an existing drug list and prices, mapped to the shared catalogue.
- **Units:** pending open question 2.

### 7.5 Security and audit
- Role-based access control, with segregation of duties on refunds, write-offs, waivers, price changes and claim withdrawals.
- Append-only audit log of who viewed or changed each record, written by the application at the point access is granted.
- Break-glass access for sensitive categories (D5).
- Encryption in transit and at rest; encrypted backups.
- Easy data export for facilities (avoids lock-in concerns).

### 7.6 File storage
- Private bucket with public access prevention enforced; no public URLs for patient documents.
- API checks permission, writes an audit entry, then returns a short-lived signed URL.
- Metadata (tenant, patient, encounter, type, checksum, uploader, object key) lives in Postgres.
- Object keys are tenant-prefixed with random names, e.g. `tenants/{facilityId}/patients/{patientId}/{uuid}`. No patient names in paths.
- Validate file type and size, strip image EXIF data, add virus scanning for external documents (e.g., upload to a quarantine bucket, scan, then move).
- Enable object versioning and soft delete.
- Enable Cloud Storage Data Access audit logs (off by default).
- Sign URLs via the service account's IAM `signBlob` permission, not key files.
- Keep all storage access behind a small interface (`put`, `get`, `createSignedUrl`, `delete`) so the provider can change.

### 7.7 Rate limiting
- `rate-limiter-flexible` with Upstash Redis in production.
- Separate limits for login, patient search (to deter record scraping), and export endpoints, keyed per user, per facility, and per IP.
- Keys use user IDs, facility IDs, and hashed IPs only. **Never** phone numbers, national IDs, member numbers or patient names.
- Use an in-memory limiter as a fast first layer and as fallback if Redis is unreachable. Decide fail-open vs fail-closed per route (general endpoints fail open; login and export stay strict).
- Redis holds counters only. No patient data, no job queues.
- Costs: Upstash pay-as-you-go is per command; consider a fixed plan once volume is steady. Keep the connection string in Secret Manager and reuse one client per Cloud Run instance.
- Measure round-trip latency between the Cloud Run region and the Upstash region.

### 7.8 Background jobs and external calls
- **Cloud Tasks** for one-off jobs (reminders, outbox drains); **Cloud Scheduler** for recurring jobs.
- **External calls never run inside a tenant transaction.** SHA, insurers, Daraja, SMS and email go through the outbox (`CLAUDE.md` rule 18).
- Workers are internal routes on the API (or a separate Cloud Run service), authenticated with Google-signed identity tokens and never public.
- Handlers must be **idempotent** (delivery is at-least-once). Use deterministic task names such as `reminder-{appointmentId}-24h` to reject duplicates.
- Payloads carry IDs only, never names, phone numbers, or clinical details.
- Check current state at run time (e.g., appointment still confirmed) instead of trying to cancel tasks.
- Record permanent failures in a Postgres table for alerting and re-runs.
- Keep the queue and Cloud Run in the same region.

The job list is in `CLAUDE.md` §7.

### 7.9 Simple enough for every role
The pilot candidate's staff find their certified system too complex (§2). In a replacement market, that is why a hospital switches, so simplicity is a requirement with tests, not a finish applied at the end.

- **One screen per job.** Each role lands on its own work queue: the cashier sees bills waiting, the lab sees specimens waiting, the ward nurse sees doses due. Nothing else appears unless they ask for it.
- **The common case is the shortest path.** Registering a returning patient, taking a payment and recording vitals each take seconds, with sensible defaults. Rare cases may take more steps; common ones may not.
- **Plain language on screen.** Diagnoses and drugs are searched by name. Codes are stored (`CLAUDE.md` rule 8) but shown only to the roles that need them, such as claims staff.
- **Never ask for what the system already knows.** Charges come from the work done (rule 16), prices from the price list, numbers from the series, the patient's coverage from their record.
- **Mistakes are easy to undo where it is safe**, such as cancelling an unassigned charge. Where it is not safe, the screen says why in plain words and who can help.
- **Works on modest hardware**: a cheap Android tablet or an old desktop, over a slow or dropping connection (PWA).
- **Measured with real staff.** Before each go-live, new staff in each role do their daily tasks after one short training session, watched and timed. Where they get stuck is a defect.
- **API consequence:** endpoints are shaped around tasks ("the cashier's queue", "dispense this order") as well as tables, so a screen is one or two calls, not a dozen stitched together.

---

## 8. Compliance notes (verify with a lawyer, the regulator, or DHA/SHA)

- **Data Protection Act 2019:** health data is sensitive personal data. Expect ODPC registration, consent handling, a DPIA, and audit trails. The data protection regulations also contain localization rules that can affect where health data is processed and stored.
- **Digital Health Act 2023 and the Digital Health Agency:** Kenya runs a national health information exchange with client, facility and health worker registries. Aligning with FHIR-style models and the DHA's Kenya ePrescription Implementation Guide (a draft at last check) will ease integration. The guide defines an extension for marking a medication as controlled and giving its schedule (I–IV).
- **DHA certification is a legal requirement.** The Digital Health (Health Information Management Procedures) Regulations, 2025 (Legal Notice 76 of 2025, regulations 36–43) require digital health solutions used in providing healthcare to be certified by DHA. Certification judges functionality and interoperability with the national health information system, and covers testing, the certificate's validity, monitoring and audits. As reported in October 2026 (verify against DHA's own guide):
  - **Prerequisites:** ODPC registration, a completed DPIA, and encryption of data at rest and in transit.
  - **Certification:** the vendor self-attests (organisation, system classification, clinical functions, reporting, security, data exchange), DHA tests the system in its lab, and a certified system is listed on DHA's public register.
  - **Integration:** each facility is then connected through **AfyaConnect**, DHA's integration platform: registration, an integration checklist, connection testing, then validation of clinical and administrative workflows.
  - **Cost:** DHA has said certification carries costs; no figures are published.
  - **Certified so far:** 28 private HMIS platforms, as of October 2026.
- **SHA requires a certified HMIS.** For the 2026/28 contracting cycle, SHA contracts only facilities on a DHA-certified HMIS connected to its platforms, for service verification, claims and data exchange. The SHA Provider Portal is being shut down. The migration deadline moved from 1 September to 30 September, then 30 October, and was last reported as **30 November 2026**. Non-compliant facilities are ineligible for contracting, renewal or continued participation. Public facilities use SHA's own Taifa Care HMIS; private and faith-based facilities choose any certified vendor.
- **Social Health Insurance Act 2023 and SHA:** SHA replaced NHIF in October 2024, with three funds (Primary Healthcare Fund, Social Health Insurance Fund, Emergency, Chronic and Critical Illness Fund). Eligibility, preauthorization, claims and remittance are **v1 requirements**. Every operational detail is to be verified (§10).
- **Pharmacy and Poisons Act (Cap 244):** contains provisions on a Poisons Book and on the supply and dispensing of Part I poisons by doctors and hospitals. The exact hospital obligations still need to be confirmed with PPB.
- **MOH reporting:** MOH 705A/705B (outpatient morbidity, under and over five) and 717 (service workload) in v1; others as a pilot hospital requires.
- **KRA eTIMS:** applicability open, decided by a tax adviser's answer (D7).

---

## 9. Questions for a pilot hospital

1. Can you share de-identified final bills for a SHA admission and an insurer admission?
2. How do deposits and interim bills work today: amounts, top-ups, and refunds when cover comes through?
3. Who are your top five insurers? For each: price list, co-pay rules, how claims are submitted, and the remittance format.
4. What is your SHA rejection rate, and the top reasons? Do you bill patients for shortfalls?
5. How do you count bed-days? Do casualty charges roll into the inpatient bill?
6. Is OPD cash-first or post-paid? Are lab tests charged when ordered or when performed? *(Decided 2026-11-10 without the pilot: both kinds of visit are supported side by side, with no setting, and lab is charged at order, §2. Still ask which is their usual case: it decides what the screens put first, never which kind of visit is allowed.)*
7. Do you sell drugs per tablet, or only in packs?
8. Who approves waivers and charity care, and how is it recorded?
9. How are your stores laid out, and who approves transfers to wards?
10. Which MOH reports do you file, and how?
11. Which HMIS do you use today, and what do you dislike about it? What would make switching worth the disruption?
12. What are connectivity and power like at each service point?
13. Which tasks in your current system take too long or confuse staff? Watch staff register a patient, take a payment and dispense, rather than only asking.
14. Can you export your data from your current system (patients, numbers, balances), and does your contract allow it?
15. When do you plan to add insurers, and when to apply for SHA contracting?
16. How many beds, which departments are open now, and which are planned?

---

## 10. Questions for SHA and DHA

**Already known** (October 2026 reporting, §8): certification is required by regulation; the steps are prerequisites → self-attestation → lab testing → public register → per-facility AfyaConnect integration; 28 private systems are certified; SHA's manual portal is closing. Questions 1–2 and 13–16 below are what remains.

1. What does certification cost, how long does it take from application to certificate, and does it require a live facility running the system?
2. What are the AfyaConnect specifications (FHIR profiles?), how is sandbox access obtained, and is authentication per vendor or per facility?
3. Is patient presence verification (OTP or biometric) mandatory, and at which points: registration, admission, discharge?
4. Must practitioners be checked against the health worker registry when a claim is filed?
5. Which ICD version and which intervention codes do claims require?
6. What does a per-diem include? What are the balance-billing and top-up rules?
7. What are the claim deadlines, required attachments and resubmission rules?
8. Are claims and remittances separated per fund? What is the remittance advice format?
9. Does PHC capitation apply at Level 4 and above?
10. Which services need preauthorization, what is the turnaround, and what are the emergency exceptions?
11. Are there hosting or data residency requirements for certified HMIS?
12. If eligibility changes during an admission, what happens to the claim?
13. Which system classifications does DHA certify under, and which functions does each require? Is there a billing-only classification?
14. How long is a certificate valid? Must each new release be re-tested, or only major changes?
15. How long does connecting one facility through AfyaConnect take once the system is certified?
16. Can a facility that is changing vendors run both systems during migration, and how are SHA claims that are still open handed over?
17. May a facility use a system whose certification application is in progress, for patients not covered by SHA? Is there a transition period, and is there a written status (e.g. "application received") a vendor can show a hospital?

---

## 11. Commercial notes

- **Pricing** *(proposed 2026-11-04, not decided)*: a per-facility monthly subscription in two parts.
  - **Package, by modules.** A facility pays for what it runs: an outpatient package (records, queues, OPD, pharmacy, billing, with lab as an option) costs less than the full hospital package, which adds wards and inpatient care. Payers (SHA and insurers) could be a further add-on.
  - **Size band within a package.** By beds, which KMHFR lists, which rarely change, and which track what a hospital earns; by monthly patient visits for a facility without beds.
  - **Not per user.** Per-user fees push hospitals to share logins, which breaks the audit trail and the named, licensed clinician that claims and the controlled-drug register need (`CLAUDE.md` rules 9, 12, 25).
  - **Not by KEPH level.** A level says what a facility is licensed to do, not how big it is or what it uses.
  - **Levels 2 and 3 later**, through the outpatient package, once the Level 4 pilot is live. They are mostly outpatient and price-sensitive, and SHA pays their primary care mostly by capitation rather than per claim (§10, question 9), so the payer module works differently for them.
  - **Code impact:** a per-facility module switch, built when the first optional module lands. Nothing in P1.
- Paid onboarding, data migration, and staff training.
- Pilot with one hospital before generalizing across hospital types. The pilot goes live as a complete cash hospital system in P6 (D8).
- **The market is a replacement market.** SHA-contracted private hospitals must be on a certified HMIS by the end of 2026, so by launch each one already runs an incumbent system. Implications:
  - Migration from the main incumbent systems (patients, numbers, open balances, open claims) is a v1 feature, not a services extra.
  - Pilot interviews should ask what the hospital dislikes about its current system, as well as how it works (§9).
  - Hospitals that are not SHA-contracted, or have little SHA volume, are the realistic first customers while certification runs (D1). **Newly opened hospitals** are the clearest case: little data to migrate, and SHA and insurers still ahead of them.
- **Simplicity is the wedge.** The pilot candidate already has a certified system and still wants to leave because it is too complex. A system ordinary staff can use with little training is the reason to switch, so it is a product principle (§7.9), not polish.
