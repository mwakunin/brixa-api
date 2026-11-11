# Roadmap

Status: proposed · Last updated: 2026-11-06

`SPEC.md` is the source of truth for decisions and open questions; `CLAUDE.md` holds the conventions code must follow; `SCHEMA.md` holds the data model. This document orders the work. It names phases, not dates: the one external date that matters is the pilot hospital's planned SHA date, and the largest dependency (DHA certification) runs on someone else's clock.

---

## 1. How the phases are ordered

**Cash billing first (P2), then the clinical modules in workflow order (P3–P5), then the pilot goes live (P6). Payers (P7) and certification (P8) follow.**

- **The cash money spine goes first** because every clinical module emits charges: a consultation, a lab order, a dispense, a bed-day. If the charge model is wrong, every one of those modules is rewritten.
- **Payers come after the pilot goes live.** The pilot candidate (`SPEC.md` §2) is a new, cash-only hospital. It can only switch once it can leave its current system entirely, so it needs every clinical module and no payer billing yet. Building payers first would delay its go-live by a whole phase for work it does not use.
- **That is safe because the payer design already exists** (`SCHEMA.md` §7, §9). P2 builds the account and charge-assignment structures payers depend on, and proves them with a test that bills a dummy insurer, so P7 adds a layer rather than reworking charges.
- **Certification is not delayed.** It almost certainly judges the complete system, so it needs P2–P7 whatever the order.
- **Reorder made 2026-11-03.** The earlier order put payers straight after P2.

**SHA's risk is external, and code cannot remove it.** No SHA claim can leave this system until DHA has certified it, and SHA's manual portal is closing, so there is no workaround (`SPEC.md` §8). **The pilot's planned SHA date is P8's deadline:** if the hospital wants SHA before this system is certified, it will stay on its current, certified system. Three things keep certification from becoming a late surprise:

1. **Phase 0 starts the prerequisites on day one** (ODPC registration, the DPIA) and gets the regulations, DHA's certification guide and the AfyaConnect specifications.
2. **A one-week AfyaConnect sandbox spike happens the moment access is granted**, whatever phase is running then. What it learns feeds back into `SCHEMA.md` §9 before P7 builds the SHA channel.
3. **Every phase keeps a certification pack current**: self-attestation answers, security evidence, test scripts. P8 then submits a pack rather than starting one.

The lesson carried from the school SaaS is that nothing tests a design like a real user. The pilot goes live in P6 as a **complete cash hospital system** (decision D8 in `SPEC.md`), and every later phase is built with live staff using the product.

**The frontend runs as its own track, designed before it is built (decided 2026-11-06).** An outpatient visit is one journey across service points (registration, triage, consultation, lab, pharmacy, cashier), so its screens are built once every step's API exists, and come out as one flow rather than being retrofitted as each module lands.

| When | Frontend work |
|---|---|
| During P3 and P4 | Settle the stack (`SPEC.md` proposes Next.js as a PWA) and set up its repo. Sketch the whole outpatient journey, screen by screen for each role, and walk the pilot's staff through it: the cheapest test of simplicity (`SPEC.md` §7.9). Where a sketch needs something the API cannot give, or asks for something it could derive, the API changes while that is still cheap. |
| From P5 | Build the outpatient screens against the finished P2–P4 API, then the inpatient screens as P5 lands. |
| P6 | Reports, offline support at the service points that need it, and the timed simplicity test with real staff before go-live. |

The risk is a crowded P5 and P6. If P5 slips, the inpatient screens start alongside it rather than waiting for it.

---

## 2. Phases

Sizes are relative: **S** about a week, **M** a few weeks, **L** a month or more of focused work.

### P0 · Discovery and external dependencies — runs in parallel throughout

**Size:** S effort, L elapsed.

- Read regulations 36–43 of Legal Notice 76 of 2025 and DHA's certification guide. Find out which classification this product certifies under, whether clinical modules are required, the cost and the lead time (`SPEC.md` §4, question 11).
- Get the AfyaConnect specifications and sandbox access (`SPEC.md` §10).
- **Before the pilot goes live:** confirm with DHA or a lawyer whether a system still in the certification process may be used at a facility, even for cash patients (`SPEC.md` §4, question 12).
- **Confirm the pilot candidate** (`SPEC.md` §2). Watch staff use their current system, confirm they can export their data, and learn when they plan to add insurers and apply for SHA (`SPEC.md` §9, questions 13–16).
- ODPC registration as a data processor, and a DPIA. Both are certification prerequisites.
- A lawyer's opinion on data residency for health data. This settles the production database host, region and bucket location (`SPEC.md` §4).
- From hospitals already on SHA and insurers, collect de-identified bills, insurer price lists and remittance samples for the payer design (`SPEC.md` §9).
- List the incumbent HMIS systems the target hospitals run, and what migrating from each would take (`SPEC.md` §11).
- Obtain SHA benefit-package and tariff documents.
- A tax adviser's position on KRA eTIMS for medical services (D7).

**Exit:** certification requirements, cost and lead time known; the pilot's SHA date known; AfyaConnect specifications in hand; ODPC registration done and the DPIA drafted; residency answered and the production host chosen; at least two hospital finance/claims interviews done, each with a de-identified bill. **Go/no-go gate** on certification lead time against the pilot's SHA date (D1).

### P1 · Foundation

**Size:** M.

Port school-saas-api's foundations with `facility_id` as the tenant key (reuse map: `CLAUDE.md` §5): two connections, a transaction per request, FORCE RLS, composite foreign keys, Better Auth with memberships, `audit_log`, rate limiting, `env.ts`, the test harness and CI.

Then fill the gaps that the school SaaS never needed:

- **Generalised number series** with reset periods (`SCHEMA.md` §6).
- **Outbox and Cloud Tasks workers**, so external calls never run inside a tenant transaction (rule 18).
- **PDF rendering** for invoices, receipts, prescriptions and claim packs, with QR verification codes.
- **Read auditing** (rule 9): who viewed a patient record or document.
- **pino redaction** and an **in-memory rate-limit fallback** (school-saas has neither).
- The **storage interface** on Google Cloud Storage, with a local implementation for development.
- **Encryption at rest and in transit**, with the evidence DHA's self-attestation asks for. This starts the certification pack (§1).
- Docker Compose on ports **5438** (dev Postgres), **5439** (test Postgres), **6383** (Redis), clear of the sibling projects.

**Exit:** the rls, enum-checks and db-access guard tests pass; an outbox job is proven idempotent under redelivery; a numbered PDF renders with a working verification QR.

### P2 · Money spine (cash)

**Size:** L.

Patients and patient numbers; the OPD encounter; a thin admission with bed stays (enough to bill, not the full ward module); billable items and price lists; charges, including manual posting; accounts; invoices, charge assignments and invoice adjustments; payments by cash, M-Pesa C2B, M-Pesa STK push, card and bank; allocations; deposits; refunds; cashier shifts; receipts.

**Exit:**
- A scripted six-day admission (deposit, running bill, top-up, final bill, partial refund) reconciles against identities M7 (`SCHEMA.md` §7.6).
- **A test bills a dummy insurer account** for part of an encounter. It proves the account and charge-assignment structures carry a payer split, so P7 needs no rework of charges.
- Concurrency tests on allocation, charge assignment and refund pass, in the style of school-saas's `allocations.test.ts`.

**Done (2026-11-06):** the six-day admission reconciles (`src/lib/reconciliation.test.ts`), the dummy insurer is billed (`src/lib/billing.test.ts`), and the concurrency tests hold one transaction open and confirm in Postgres that the other waits (`src/lib/concurrency.test.ts`). Also built in P2: M-Pesa C2B and STK push, reversing an approved adjustment, and the daily reconciliation check (decisions of 2026-11-06).

### P3 · OPD clinical and lab

**Size:** M/L.

Service-point queues and appointments; triage and vitals; consultation notes; ICD diagnoses; orders that raise charges; printable prescriptions. Lab: test catalogue, specimen accession, results entry, and verification by a second person.

**Exit:** a full OPD journey (registration → triage → consultation → lab → cashier) with no manual charge posting. Medication orders produce printable prescriptions; dispensing joins the journey in P4.

**Slices** (2026-11-10). Each follows P2's pattern: a migration pair, a lib module, routes and tests, and an "As built" note in `SCHEMA.md`.

| PR | Slice | Builds |
|---|---|---|
| A | 1a Practitioners | A licence (profession, number, expiry) on memberships and invitations for every clinical role; roles may span professions under the person's one licence; the admin changes a member's roles and renews licences, and sees those expiring within 30 days; clinical routes refuse a lapsed licence |
| A | 1b Service points and queues | Service points; queue entries for triage and consultation only (the lab, pharmacy and cashier lists are derived from the work waiting); the attending clinician, derived; a nightly run closes outpatient visits still open after their day. A visit closing itself once nothing is pending waits for 4a, when "pending" (orders not done) exists |
| A | 1c Consultation fee and paying | A fee item per clinic, charged once per visit per clinic when the patient joins its queue; the cashier's "due now" list; the cashier bills what is unbilled whenever the patient pays, on an interim invoice, or at the end on the final invoice |
| A | 2 Triage | Vitals as observations (marked entered in error, never edited); allergies; triage priority orders the consultation queue |
| A | 3a Diagnoses | `icd_codes`, the first shared reference table, loaded from WHO's ICD-11 release; search by name; diagnoses copy the code and title |
| A | 3b Clinical notes | Signed notes frozen and corrected by addendum; clinical reads limited to clinical roles and audited |
| B | 4a Orders and lab catalogue | Orders and their items (lab, medication, service); lab tests with analytes and reference ranges; lab and service items charged at order, the charge cancelled with an order not yet done; walk-in lab clients with an outside requester |
| B | 4b Prescriptions | The shared `drug_catalogue` at generic level; medication items with quantities in dose units, so the units-of-sale question (`SPEC.md` §4, question 2) stays with P4; a printed `RX-` prescription with the prescriber's licence and the patient's allergies; no charge until dispensing (P4) |
| B | 5a Specimens | The lab worklist; collection issues the daily accession number; receive, reject and recollect; a warning on any test not yet paid for, except in an emergency visit |
| B | 5b Results | Entry per analyte; flags from the ranges; verification by another lab member; frozen with the range applied; a correction is a new version; a printed lab report |
| C | 6 Appointments | Book, move, cancel, check in; SMS reminders through the outbox by Africa's Talking, the code built now and its credentials configured later |
| C | 7 Sensitive records | Marking sensitive items, and break-glass (rule 27) |
| C | 8 Exit | The scripted journey with no manual charges and a clean reconciliation; a clinical-functions page in the certification pack |

**Decided 2026-11-10** (product owner): patients pay at each point or at the end, with no setting to choose between them, and an unpaid test a warning at the lab, never a block; roles may span professions (a nurse who also dispenses works under her nursing licence), and the admin changes a member's roles; SMS by Africa's Talking, the code first and its credentials later; lab charged at order; the consultation fee per clinic; any lab member other than the one who entered a result verifies it; a printed lab report; walk-in lab clients in P3. Recommendations accepted with them: queues stored for triage and consultation only; a licence required for every clinical role, its expiry stored, warned 30 days ahead and refused once lapsed, with no registry check until AfyaConnect (`SPEC.md` §10, question 4); a visit closes itself once nothing is pending; order kinds lab, medication and service; the drug catalogue at generic level in 4b; notes, diagnoses and results readable by clinical roles only.

**Proposed, to confirm:**
- **From the ecc healthcare guidance:**
  - Prescribing against a recorded drug allergy is blocked unless overridden with a reason, and the override is audited.
  - Prescribing for a child needs a weight taken that day.
  - Lab analytes carry critical limits, and verifying a critical result records who was told and when.
  - The ordering clinician gets a results-to-review list and acknowledges each result.
  - Abnormal vital signs are flagged for adults; children's thresholds depend on age and need care.
  - Sensitive billable items print under a neutral name.
  - Sensitivity comes from ICD codes, lab tests and clinics.
  - Break-glass alerts go to an in-app list for the attending clinician and the facility admin.
- **One lab member on night duty:** a result released unverified, with a reason, and verified by the next person on duty. This changes `SCHEMA.md` §8 ("a result reaches the clinician only once verified").

**Decided 2026-11-10:** diagnoses are coded in ICD-11 (`SPEC.md` §4, question 8).

**Still open:** whether the MOH 705 report's grouping of ICD-11 codes into MOH's condition list needs WHO's written agreement, since WHO's licence puts mappings between classifications outside it (`SCHEMA.md` §8, slice 3a); the pilot's MOH 705 and 717 forms, so P3 captures what P6 reports need (§9, question 10); whether SMS reminders need the patient's consent; drug-interaction and dose data (none in v1 without a licensed source).

### P4 · Pharmacy and stores

**Size:** L.

Main store, pharmacy and ward sub-stores; transfers; goods received; batches and FEFO dispensing; dispense → charge; returns; the controlled-drug register; stock take; reorder levels; expiry and low-stock alerts (the nightly job in `CLAUDE.md` §7). Units of sale wait on open question 2 in `SPEC.md`.

**Exit:**
- The stock identity holds per store and batch (on hand = Σ movements, never negative).
- The controlled-drug register balances against movements.
- A batch nearing expiry and an item below its reorder level each produce an alert.
- The full OPD journey now includes pharmacy (registration → triage → consultation → lab → pharmacy → cashier), still with no manual charge posting.

### P5 · Inpatient clinical

**Size:** L.

Bed board; transfers; nursing notes; observation charts, with the NEWS2 early-warning score for adults (moved here from P3 on 2026-11-10: it is built for spotting deterioration on the wards, and outpatient triage uses the emergency/urgent/routine priority instead); the medication administration record (MAR); ward rounds; the discharge summary.

**Exit:** admission to discharge with a signed discharge summary and no paper.

### P6 · Pilot go-live (cash)

**Size:** M.

Everything the pilot needs to leave its current system on one day:

- **Migration** from the pilot's current system: patients and legacy numbers (`SCHEMA.md` §6), open balances and deposits. The hospital is new, so the volume is small; the tooling is still built to be reused.
- **Opening stock**, from a physical count on cutover day: per store and batch (batch number, expiry, quantity, cost), loaded as `opening_balance` movements (`SCHEMA.md` §8). Controlled drugs also get an opening entry in their register, matching the old register's closing balance. Without this, stock on hand would be zero on day one and nothing could be dispensed.
- **Reports a facility must file or run daily:** MOH 705A/705B and 717, revenue and cashier summaries, stock status.
- **PWA offline support** at the service points that need it.
- **M-Pesa hardening before real money.** A way for the facility admin to rotate a leaked callback token: a new token, its URLs registered with Safaricom, and the old one kept for a short grace period so callbacks for prompts already sent still land. In that period the old token must accept only callbacks for prompts sent before the rotation, never paybill confirmations, or a leaked token keeps working for its whole length. A way to recover a prompt callback kept as "Could not be recorded" (its own transaction failed, and Safaricom does not call again): replay it with the first attempt's safeguards, or put its payment in the queue. And a decision: may two facilities (a hospital group's branches) share one paybill? Today nothing stops it, but Safaricom registers one set of callback URLs per paybill, so the second registration takes all its confirmations. Either refuse a shortcode another facility holds, or route by account reference. Found in the full review of PR #9.
- **Backups and a disaster-recovery drill**, and a security review before real patient data arrives.
- **Migrations that are safe on live data.** Adding an audit action rewrites the `audit_log_action_known` CHECK, which re-scans the whole log while holding a lock that blocks every audit write, and so every request that audits. The drizzle migrator applies all pending migrations in one transaction, so `NOT VALID` followed by `VALIDATE CONSTRAINT` cannot help as things stand. Before go-live: a migrator that commits each migration on its own (or a separate validate step at deploy), or a lookup table of known actions in place of the CHECK. Found in review of PR #4.
- **Training and the simplicity test** (`SPEC.md` §7.9): new staff in each role do their daily tasks after one short session, watched and timed. Where they get stuck is fixed before go-live.
- **The tariff before the first patient:** every ward's bed-day item set and the cash tariff approved before cutover, because prices are never backdated and a night before its price can never be charged (`SCHEMA.md` §7.2).
- **Legal clearance** from P0: written confirmation that the pilot may run this system before certification.

**Exit:**
- The pilot runs entirely on this system for cash and M-Pesa patients, with the old system switched off.
- Stock on hand per store and batch, after the opening load, equals the signed count sheets.
- Each controlled drug's register balance equals the old register's closing balance.

### P7 · Payers and claims

**Size:** L.

Payers and schemes; patient coverages; the encounter billing plan; the eligibility log; preauthorizations; package lines; claims and claim versions; claim-pack export; remittance import; disallowance → rebill or write-off; debtor ageing by payer. A `PayerGateway` interface with two implementations:

- `manual` for private insurers: claim packs and remittance import.
- `afyaconnect` for SHA eligibility, preauthorization and claims, built against the sandbox. It cannot go live until P8.

Insurer billing goes live at the pilot as soon as it is ready, timed to when the hospital signs its first insurers. Until then, any insurer bill is printed and submitted by hand.

**Exit:**
- These three scenarios reconcile: a SHA package admission; an insurer OPD visit with a co-pay; a SHA → insurer → patient cascade.
- A partial remittance is imported, and the shortfall becomes a disallowance or stays open (M6).
- A working claims officer reviews a generated claim pack.
- SHA eligibility checks and claim submission pass against the AfyaConnect sandbox.
- The pilot bills its insurers through the system.

### P8 · Certification and SHA live

**Size:** M, plus external lead time. **Deadline:** the pilot's planned SHA date (P0).

- Submit the certification pack to DHA: self-attestation, then lab testing (`SPEC.md` §8).
- A penetration test, and an update of the DPIA drafted in P0.
- Connect the pilot facility through AfyaConnect and switch SHA claims on.

**Exit:** certified and listed on DHA's register; the pilot submits SHA claims through the system.

---

## 3. Out of v1

Named so nobody builds them by accident. Each one has room in the design.

| Item | Why it waits | Where it lands later |
|---|---|---|
| Theatre scheduling | Procedures are orders and charges in v1; scheduling is its own product | After P5 |
| Maternity and partograph | Specialised clinical forms; ANC visits work as ordinary encounters | After P5 |
| PACS, imaging beyond orders and text reports | Needs a DICOM integration | After P8 |
| Lab analyser interfaces | Manual result entry in v1 | After P3 is live |
| Automatic KHIS/DHIS2 push | v1 exports the MOH reports | After P8 |
| Double-entry ledger | Port tour-api's ledger and outbox once the cost side exists | Later |
| Supplier payables, LPOs | Port tour-api / school-saas Phase 2 design; goods received in v1 records the supplier as text | Later |
| Payroll | Statutory deductions make it its own product | Not planned |
| Insurer e-claims (SMART, Slade360) | v1 insurer claims are batches with manual remittance | After P8 |
| Patient portal, telehealth | Not what a Level 4 hospital buys first | Not planned |
| WhatsApp reminders | Reminders go by SMS in v1 | Revisit with Brevo or another provider after P6 |
| eTIMS | Waits on a tax adviser's answer (D7) | Depends on D7 |
