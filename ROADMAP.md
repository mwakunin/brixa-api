# Roadmap

Status: proposed · Last updated: 2026-11-06

`SPEC.md` is the source of truth for decisions and open questions; `CLAUDE.md` holds the conventions code must follow; `SCHEMA.md` holds the data model. This document orders the work. It names phases, not dates: the one external date that matters is the pilot hospital's planned SHA date, and the largest dependency (DHA certification) runs on someone else's clock.

---

## 1. How the phases are ordered

**Cash billing first (P2), then the outpatient clinical modules in workflow order (P3–P4), then the frontend, and the pilot goes live as an outpatient hospital (P6). Inpatient (P5), payers (P7) and certification (P8) follow.**

- **The cash money spine goes first** because every clinical module emits charges: a consultation, a lab order, a dispense, a bed-day. If the charge model is wrong, every one of those modules is rewritten.
- **Payers come after the pilot goes live.** The pilot candidate (`SPEC.md` §2) is a new, cash-only hospital. It can only switch once it can leave its current system entirely, so it needs every clinical module it uses (outpatient, lab and pharmacy; it has no wards yet) and no payer billing yet. Building payers first would delay its go-live by a whole phase for work it does not use.
- **That is safe because the payer design already exists** (`SCHEMA.md` §7, §9). P2 builds the account and charge-assignment structures payers depend on, and proves them with a test that bills a dummy insurer, so P7 adds a layer rather than reworking charges.
- **Certification is not delayed.** It almost certainly judges the complete system, so it needs P2–P7 whatever the order.
- **Reorder made 2026-11-03.** The earlier order put payers straight after P2.
- **Reorder made 2026-11-17: inpatient (P5) follows go-live.** The pilot has no inpatient service yet, so it can leave its current system without one. What stands between it and go-live is the screens, so the frontend comes next, straight after P4. P5 keeps its number and starts when the pilot plans to open wards, or when another facility needs it. Admissions, wards, beds and bed-day charges (P2) stay as built.

**SHA's risk is external, and code cannot remove it.** No SHA claim can leave this system until DHA has certified it, and SHA's manual portal is closing, so there is no workaround (`SPEC.md` §8). **The pilot's planned SHA date is P8's deadline:** if the hospital wants SHA before this system is certified, it will stay on its current, certified system. Three things keep certification from becoming a late surprise:

1. **Phase 0 starts the prerequisites on day one** (ODPC registration, the DPIA) and gets the regulations, DHA's certification guide and the AfyaConnect specifications.
2. **A one-week AfyaConnect sandbox spike happens the moment access is granted**, whatever phase is running then. What it learns feeds back into `SCHEMA.md` §9 before P7 builds the SHA channel.
3. **Every phase keeps a certification pack current**: self-attestation answers, security evidence, test scripts. P8 then submits a pack rather than starting one.

The lesson carried from the school SaaS is that nothing tests a design like a real user. The pilot goes live in P6 as a **complete cash outpatient hospital system** (decision D8 in `SPEC.md`, revised 2026-11-17), and every later phase is built with live staff using the product.

**The frontend is the next piece of work, designed before it is built (track decided 2026-11-06; made the main line 2026-11-17).** An outpatient visit is one journey across service points (registration, triage, consultation, lab, pharmacy, cashier). Every step's API exists since P4, so its screens are built as one flow rather than retrofitted module by module.

Decided 2026-11-17, as recommended:

1. **Stack:** Next.js 16 as a PWA, React 19, TanStack Query, Tailwind 4 with shadcn/ui, the Better Auth client, and types generated from this API's OpenAPI document (`/doc`). It is the stack of the sibling project `hbserenity-web`.
2. **Its own repository,** `brixa-web`, beside this one, with its own CI.
3. **Design before build:** each role's screens are sketched as a clickable mockup of one patient's visit, end to end, and the pilot's staff are walked through it before the screens are built. That is the cheapest test of simplicity (`SPEC.md` §7.9). Where a sketch needs something the API cannot give, or asks for something it could derive, the API changes while that is still cheap.
4. **Order of screens:** sign-in and the facility picker; then front desk, triage, consultation, lab, pharmacy and cashier; then stores and administration. Each role lands on its own work queue.
5. **Devices:** desktop and tablet, over a slow or dropping connection. Not phones in v1.
6. **Language and look:** English in v1, with every string in one place so Swahili can follow. A plain, high-contrast design until there is a brand.

| Step | Frontend work |
|---|---|
| F1 Foundation | The `brixa-web` repository, its stack and CI, and the typed API client. |
| F2 The journey, sketched | The outpatient journey as a clickable mockup, screen by screen for each role, walked through with the pilot's staff. The API gaps it shows are fixed here. |
| F3 The outpatient screens | Built in the order above against the P2–P4 API. |
| P6 | Reports, offline support at the service points that need it, and the timed simplicity test with real staff before go-live. |

The inpatient screens come with P5.

**F2 was walked through with the pilot's staff on 2026-11-20.** Every screen survives, with changes (brixa-web's `docs/outpatient-journey.md`). The API gaps it found are being fixed in two pull requests:
1. **The front desk** (#35, in review): each search result's identity document, and a patient's contacts.
2. **The other desks** (#36, in progress; until it merges, none of these exist):
   - the consultation's one read for the patient;
   - today's complaint at triage;
   - the pharmacy's stock flag and its quote before preparing;
   - the receipt's address, items and cashier.

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

**Done (2026-11-15):** `src/routes/opd-journey.test.ts` runs a day's outpatients through the API. One patient pays at each step in cash (triage, the clinic's fee, a lab test charged at order, the result verified, a review, a printed prescription). One comes on an appointment and pays the final bill by M-Pesa paybill. One is a walk-in for the lab with an outside requester. No charge is posted by hand, every visit closes itself, the cashier's list ends empty, and the reconciliation check finds no drift with M7's identities holding. The clinical functions are described, with their evidence, in `docs/certification/clinical-functions.md`.

**Slices** (2026-11-10). Each follows P2's pattern: a migration pair, a lib module, routes and tests, and an "As built" note in `SCHEMA.md`.

| PR | Slice | Builds |
|---|---|---|
| A | 1a Practitioners | A licence (profession, number, expiry) on memberships and invitations for every clinical role; roles may span professions under the person's one licence; the admin changes a member's roles and renews licences, and sees those expiring within 30 days; clinical routes refuse a lapsed licence |
| A | 1b Service points and queues | Service points; queue entries for triage and consultation only (the lab, pharmacy and cashier lists are derived from the work waiting); the attending clinician, derived; a nightly run closes outpatient visits still open after their day. A visit closing itself once nothing is pending waits for 5b, when lab orders can finish |
| A | 1c Consultation fee and paying | A fee item per clinic, charged once per visit per clinic when the patient joins its queue; the cashier's "due now" list; the cashier bills what is unbilled whenever the patient pays, on an interim invoice, or at the end on the final invoice |
| A | 2 Triage | Vitals as observations (marked entered in error, never edited); allergies; triage priority orders the consultation queue |
| A | 3a Diagnoses | `icd_codes`, the first shared reference table, loaded from WHO's ICD-11 release; search by name; diagnoses copy the code and title |
| A | 3b Clinical notes | Signed notes frozen and corrected by addendum; clinical reads limited to clinical roles and audited |
| B | 4a Orders and lab catalogue | Orders and their items (lab, medication, service); lab tests with analytes and reference ranges; lab and service items charged at order, the charge cancelled with an order not yet done; walk-in lab clients with an outside requester |
| B | 4b Prescriptions | The shared `drug_catalogue` at generic level; medication items with quantities in dose units, so the units-of-sale question (`SPEC.md` §4, question 2) stays with P4; a printed `RX-` prescription with the prescriber's licence and the patient's allergies; no charge until dispensing (P4) |
| B | 5a Specimens | The lab worklist; collection issues the daily accession number; receive, reject and recollect; a warning on any test not yet paid for, except in an emergency visit |
| B | 5b Results | Entry per analyte; flags from the ranges; verification by another lab member, recording who was told of a critical result; frozen with the range applied; a correction is a new version; a printed lab report; a visit closing itself once nothing is pending |
| C | 6 Appointments | Book, move, cancel, check in; SMS reminders through the outbox by Africa's Talking, the code built now and its credentials configured later |
| C | 7 Sensitive records | Marking sensitive items, and break-glass (rule 27) |
| C | 8 Exit | The scripted journey with no manual charges and a clean reconciliation; a clinical-functions page in the certification pack |

**Decided 2026-11-10** (product owner): patients pay at each point or at the end, with no setting to choose between them, and an unpaid test a warning at the lab, never a block; roles may span professions (a nurse who also dispenses works under her nursing licence), and the admin changes a member's roles; SMS by Africa's Talking, the code first and its credentials later; lab charged at order; the consultation fee per clinic; any lab member other than the one who entered a result verifies it; a printed lab report; walk-in lab clients in P3. Recommendations accepted with them: queues stored for triage and consultation only; a licence required for every clinical role, its expiry stored, warned 30 days ahead and refused once lapsed, with no registry check until AfyaConnect (`SPEC.md` §10, question 4); a visit closes itself once nothing is pending; order kinds lab, medication and service; the drug catalogue at generic level in 4b; notes, diagnoses and results readable by clinical roles only.

**Proposed, to confirm:**
- **From the ecc healthcare guidance:**
  - ~~The ordering clinician gets a results-to-review list and acknowledges each result.~~ Decided 2026-11-17, below.
  - Abnormal vital signs are flagged for adults; children's thresholds depend on age and need care.
  - Sensitive billable items, where sensitivity comes from, and the break-glass alerts were decided for slice 7 (2026-11-15, below).

**Decided 2026-11-10:** diagnoses are coded in ICD-11 (`SPEC.md` §4, question 8).

**Decided 2026-11-11** (product owner, for 4a; recommendations accepted):
- **Orders.** Doctors, clinical officers and nurses order. An order's items are lab tests or services (procedure, imaging or service items); consumables wait for P4's stock. An order is routine or urgent.
- **Done, and cancelling.** A lab test is done once its specimen is collected (5a), and a service item once a clinician marks it performed. Until then an item may be cancelled, which cancels its charge while unbilled; after that the charge stands.
- **Walk-in lab clients** are registered as ordinary patients, on an outpatient visit that joins no queue. Records clerks and lab members enter the request: an outside requester's name and facility (the licence number if given), or a test the client asks for themselves, marked self-requested.
- **The lab catalogue** is kept by the facility admin and the lab supervisor. Analytes are numeric (with a unit, reference ranges by sex and age, and critical limits), a choice from a list, or free text. No test menu is shipped: each facility sets up its own, and no reference range is made up for it.
- **A visit closing itself** once nothing is pending counts money still due as pending, since the cashier's list shows open visits only. It is built in 5b, once lab orders can finish.

**Decided 2026-11-11** (product owner, for 4b; recommendations accepted):
- **The drug catalogue** is loaded from a CSV file in this system's own format (generic name, strength, form, dose unit, route, controlled schedule), with a small sample for development and tests. The list to fill it is PPB's Generic Products list, which DHA's ePrescription guide requires for a prescribed medicine's code (decided 2026-11-12). It waits on its terms and an export from PPB or DHA (Open Concept Lab allows no anonymous access), and on a pharmacist's review: the guide's copy has entries with implausible strengths.
- **Drug allergies** block a prescription of the same generic drug, an ingredient of a combination included, unless the prescriber gives a reason, which is audited. A drug allergy may name the catalogue drug; one recorded as text alone is matched by name. Drug classes wait for a source that carries them. The allergies print on the prescription: as many as fit its 500-character field, then how many more to check on the patient's record.
- **A child under 12** needs a weight taken that day before anything is prescribed. The age is to be confirmed by a clinician.
- **Prescribers:** doctors, clinical officers and nurses; a controlled drug, doctors and clinical officers only.
- **The prescription** is numbered from a yearly `RX-` series (`RX-2026-000001`) as it is written, with a QR code; existing facilities get the series by backfill. It is changed by cancelling it, which voids the paper, and writing a new one.
- **A medicine** records its drug, dose and dose unit, route, a frequency from a fixed list (OD, BD, TDS, QID, nocte, PRN, STAT), a duration in days, a quantity in dose units (worked out from a regular frequency unless given) and instructions.

**Decided 2026-11-11** (product owner, for 5a; recommendations accepted):
- **A specimen** is taken for the ordered tests its collector picks on one order, by default every waiting test of one specimen type, and takes an accession number from a daily series (`L-20261111-017`).
- **Lab members, nurses and ward nurses collect.** A specimen the lab takes is received at once; a nurse's is received by the lab.
- **Rejection** is for a reason from a fixed list (haemolysed, clotted, insufficient, wrong container, mislabelled, leaked, too old, other with a note). Recollecting takes a new specimen with a new number; the rejected one keeps its number.
- **Paid**, for the lab's warning, means the test's charge is on finalised bills that owe nothing. The warning shows at outpatient visits only: never at an emergency, nor for an admission, which runs its own bill.
- **The worklist** shows tests to collect, specimens to receive and specimens in the lab, urgent first, then oldest. It is the lab's alone, and each view is audited.
- **A test not collected when its visit closes** (a fasting sample, or "pay now, come back tomorrow") stays on the worklist for 7 days after the visit, below the patients still at the hospital. It is not cancelled: its charge stands, and the lab collects it on the patient's return (decided 2026-11-12).

**Decided 2026-11-11** (product owner, for 5b; recommendations accepted):
- **A result** is one test's values on one specimen, entered together and verified together by another lab member. A correction is a new version; the one it corrects stays on record.
- **One lab member working alone** (on night duty; at the pilot often by day too, found in the staff walkthrough on 2026-11-20) may release a result unverified, with a reason; it reaches the clinician marked unverified until the next lab member verifies it. (Proposed earlier; it changes "a result reaches the clinician only once verified".)
- **A critical value** is not released or verified until who was told, how (in person or by phone) and when is recorded.
- **The lab report** is one per order, from a yearly `LR-` series, issued once every test on it is resulted or cancelled; a change to a result voids it and a new one is issued.
- **A visit closes itself** through a check every 15 minutes, once its patient is in no queue, every test is resulted or cancelled and every service done, nothing is owed, and the patient was seen or tested. Medicines are not waited for until dispensing exists (P4).
- **Flags** come from the range for the patient's sex and age in days at collection; a patient who is intersex, or whose sex is not recorded, is judged against `any` ranges only. The results-to-review list was decided on 2026-11-17 (below).

**Decided 2026-11-13** (product owner, for 6; recommendations accepted):
- **An appointment** is booked at a clinic (a consultation point) for a date, with a time and a clinician if wanted, from today to a year ahead. No slots, daily caps or clinic days in v1: the day's list shows how many are booked, and a second booking at the same time is allowed. Its lifecycle is booked, then checked in or cancelled (with a reason); one still booked after its day is shown as missed, derived and never stored.
- **Booking, moving and cancelling** are for records clerks, nurses, ward nurses, doctors, clinical officers and the facility admin. **Checking in** opens a visit, so it is for the same staff except ward nurses, who do not open visits. None is a clinical act. A follow-up booked during a visit records that visit. Moving changes the date or time while the appointment is booked, audited with the old and new, and queues a new reminder. There is no free-text reason: the clinic says what it is for.
- **Checking in** is on the appointment's own day (a patient who comes on another day is moved to today first). It opens the visit, or uses the one already open, and the patient goes to triage like any visit, or straight to the booked clinic if the clerk says so. Booked patients take no priority over walk-ins in the clinic's queue.
- **SMS reminders need the patient's yes**, asked once and recorded with who asked and when; nothing is sent before it. Whether the law requires it is still for the lawyer; asking costs little either way.
- **The reminder** is one SMS at 17:00 Kenyan time the day before, none for a booking made after that, and no message at booking. It gives the patient's given name, the facility, the date and time, and the facility's phone number to call to change it (the facility admin sets the number). It never names the clinic, the clinician or the reason, since phones are shared and a clinic's name can disclose an HIV or mental-health diagnosis. Kenyan numbers only.
- **The reminder is an outbox job held back to its time** (`available_at`) and delivered by the minute's sweep, not a Cloud Task scheduled at booking: Cloud Tasks schedules at most 30 days ahead, and chronic clinics book months ahead. It re-reads the appointment when it runs and is skipped if it no longer fits.
- **Africa's Talking** is one account for the platform, configured in the environment, with each message's cost recorded per facility; a facility may have its own sender ID. Delivery reports wait for a public callback.
- **A review visit's fee** is charged like any other. The pilot's doctors waive a fee case by case, through the cashier as a waiver (the staff walkthrough, 2026-11-20). The visit a follow-up was booked from is recorded.

**Decided 2026-11-15** (product owner, for 7; recommendations accepted):
- **Sensitive categories** are HIV, mental health and gender-based violence (rule 27). An item is sensitive when it is a diagnosis under a code on this system's list (HIV 1C60–1C62, mental health chapter 06, and the GBV codes a clinician names; the list is to be confirmed by a clinician), a result of a lab test the catalogue's keepers mark, a note its author marks, or anything recorded during a visit to a clinic the facility admin marks.
- **What is hidden:** a sensitive item on its own (a diagnosis, a result, a marked note), and everything clinical recorded in a visit to a sensitive clinic (notes, diagnoses, orders, prescriptions, results and their printed documents). Vital signs, allergies, queues, appointments and the bill are not hidden. A hidden item shows as a restricted record with its date and no category, since a category alone discloses.
- **Who sees it without breaking the glass:** whoever recorded it; staff the facility admin assigns to its category (the HIV clinic's staff to HIV), each assignment audited; and the lab on its own worklist. Every other clinician breaks the glass; non-clinical roles read no clinical content at all.
- **Breaking the glass** is open to any clinical member with a current licence, always with a reason, emergencies included. It opens that one patient's sensitive items for 12 hours; each read during it is audited, and marked as one.
- **The alert** is an in-app list for the facility admin and for the clinicians who recorded what was opened, not an SMS or email. The facility admin marks each one reviewed.
- ~~**Medicines:** an HIV medicine prescribed outside a sensitive clinic is not caught, since the drug list carries no classes.~~ Done in P4 slice 3c: the facility marks catalogue drugs sensitive, and their prescriptions are restricted.
- **Neutral names on bills:** a billable item may have a neutral printed name ("Laboratory test"), which invoices and receipts print. The charge copies it at capture, as it copies the price.

**Still open after P3** (2026-11-15), each for its owner:
- **A clinician:** the age below which a weight is needed to prescribe (`CHILD_UNDER_YEARS = 12`); the injected-route rule; the list of sensitive ICD-11 codes, and the GBV codes to add to it.
- **A pharmacist:** a review of the drug list before it is loaded, and the controlled schedules PPB's list does not carry.
- ~~**The pilot:** whether a review visit within a few days is charged a second consultation fee.~~ Answered on 2026-11-20: it is, and the doctor waives it case by case.
- **Proposed, not decided:** abnormal vital-sign flags. (The results-to-review list was decided on 2026-11-17, below.)
- ~~**The outbox's next change:** a claim token, so an attempt that outlived its lease cannot finish a job another attempt holds (found in review of PR #17).~~ Done in the chore PR after #17: `outbox.claim_token`, new on each claim and required by every outcome write (`src/jobs/outbox-worker.ts`).

**Also still open:** whether the MOH 705 report's grouping of ICD-11 codes into MOH's condition list needs WHO's written agreement, since WHO's licence puts mappings between classifications outside it (`SCHEMA.md` §8, slice 3a); the pilot's MOH 705 and 717 forms, so P3 captures what P6 reports need (§9, question 10); whether SMS reminders legally need the patient's consent (they are asked for it anyway, decided 2026-11-13); drug-interaction and dose data (none in v1 without a licensed source).

**Decided 2026-11-17: results back to the clinician** (as recommended; found while sketching the outpatient screens, `brixa-web` `docs/outpatient-journey.md`). Nobody in the lab may put a patient in a clinic's queue, nothing told the doctor a result was ready, and a visit with nothing pending closes itself: a patient who had paid could have their visit closed before the doctor saw the result.

1. **Back automatically.** When the last lab test still waiting on a visit has its result released or verified, the patient rejoins the queue of the clinic that sent them, with no second fee.
2. **The clinician decides, defaulting to yes.** Finishing with a patient whose tests still wait asks them to come back; "no need to come back" (`comeBackWithResults: false`) leaves the results for a later visit.
3. **Every result, not the first.** A test rejected and to be taken again still waits; a cancelled one does not. The clinician may still send for the patient early, by hand.
4. **Only when free:** the visit still open and the patient in no other queue. Otherwise the result waits on the list (5).
5. **A results-to-review list** for each doctor, clinical officer and nurse who orders: results of their tests not yet marked reviewed, critical first, then abnormal, then the longest waiting, with "mark reviewed". A corrected result is reviewed again. Anyone who orders may also read every clinician's, so none waits on someone off duty. A walk-in's results go to the outside requester and are not listed.
6. **A queue row says why the patient is there:** back with results, and the time a checked-in appointment was booked for. Returning patients take their turn by arrival; the clinician may call any waiting patient in.

### P4 · Pharmacy and stores

**Size:** L.

Main store, pharmacy and ward sub-stores; transfers; goods received; batches and FEFO dispensing; dispense → charge; returns; the controlled-drug register; stock take; reorder levels; expiry and low-stock alerts (computed when read, slice 6). Drugs are dispensed per tablet: stock is counted in a base unit (decided 2026-11-15, `SPEC.md` §4, question 2).

**Exit:**
- The stock identity holds per store and batch (on hand = Σ movements, never negative).
- The controlled-drug register balances against movements.
- A batch nearing expiry and an item below its reorder level each produce an alert.
- The full OPD journey now includes pharmacy (registration → triage → consultation → lab → pharmacy → cashier), still with no manual charge posting.

**Slices** (agreed 2026-11-15). Each follows P3's pattern: a migration pair, a lib module, routes and tests, and an "As built" note in `SCHEMA.md`.

| PR | Slice | Builds |
|---|---|---|
| A | 1a Stores and stock items | Stores (main store, pharmacy, ward and other sub-stores). The facility's stock items: a catalogue drug or a consumable, each with a billable item, so its selling price goes through the price list and `resolvePrice`. The units it is counted and sold in (question 1). A reorder level per item per store |
| A | 1b Goods received | Receipts into a store, the supplier as text: batch number, expiry, quantity and unit cost. Each is a `receipt` movement. Stock on hand per store and batch is derived (Σ movements), with a stock-status view |
| A | 1c Item import | A facility's drug and consumable list and prices loaded from a CSV and mapped to the catalogue (`SPEC.md` §7.4), so a hospital is not set up by hand. Opening stock waits for P6's cutover |
| B | 2 Transfers | Requested, approved, sent and received between stores, with a difference on receipt explained and adjusted |
| B | 3a Dispensing | The pharmacy's list of prescriptions waiting. Prepared from the pharmacy's stock, earliest expiry first. Raises the charge, then is handed over (question 5). Partly dispensed, or marked not supplied. Visits close only once each medicine is dispensed or marked not supplied |
| B | 3b Returns and adjustments | A patient's return credits its charge while unbilled, and is credited or refunded once billed. Write-offs (expired, damaged) and other adjustments need a reason and a second person (rule 24) |
| B | 3c Sensitive medicines | Catalogue drugs a facility marks sensitive; their prescriptions restricted as a sensitive lab test restricts its order (question 12, decided 2026-11-15) |
| C | 4 Controlled drugs | The register, per item and store, with a running balance (rule 12). Who may dispense them. Its entries balance against the movements |
| C | 5 Stock take | A count per store, then the variances, each an adjustment approved by a second person |
| C | 6 Alerts and exit | The nightly expiry and low-stock scan (`CLAUDE.md` §7) and the lists they feed. The OPD journey extended through the pharmacy. The stock identity and the register checked as P4's exit |

**Questions before code** (all decided 2026-11-15, with the recommendations; 2–12 refined from the first draft):
1. **Loose units or packs: per tablet.** Stock is counted in a base unit (tablet, capsule, mL, vial), with a pack size. Goods are received in packs and converted, and the price is per base unit, since a unit price may carry fractional shillings (D2). A prescription's quantity, already in dose units (P3 slice 4b), is dispensed in the same unit where the two match.
2. **Cost: per batch, at its own cost.** Each goods-received line keeps its **total cost** as the supplier's delivery note shows it, with its quantity in base units. The unit cost is derived from the two, never stored: a pack of 30 for KES 350 is 1,166.67 cents a tablet, which integer cents cannot hold. Stock is valued at batch cost, rounded only in the valuation report. No average costing, and no ledger in v1 (§3).
3. **Selling prices: through the price list.** Each stock item has its own billable item (category `drug` or `consumable`), priced by the existing price changes, approved by a second person (rule 24). The item import (1c) loads its prices as one price change awaiting approval, so the opening tariff is approved too. An item with no cash price cannot be prepared for dispensing (refused, as an unpriced lab order is), never sold at zero. The optional markup per category (`SPEC.md` §7.4) waits until a facility asks for it.
4. **Who dispenses:** pharmacists and pharmacy technicians, under a current licence. A nurse who holds the pharmacy technician role (night cover, `SCHEMA.md` §8, slice 1a) dispenses ordinary medicines. **A controlled drug needs the pharmacist role and a pharmacy (PPB) licence**, so a nurse never dispenses one, whatever her roles. This answers the question slice 1a of P3 left open.
5. **Paying before the hand-over: two steps.** Preparing takes the stock and raises the charge; handing over completes the dispense. A prepared dispense not handed over can be cancelled, which returns the stock and cancels the unbilled charge. An unpaid outpatient's hand-over shows a warning and is never blocked, as at the lab, since paying at the end is allowed (`SPEC.md` §2). A prepared dispense the patient never collects stays on the pharmacy's list until the pharmacist cancels it: no job cancels it, because the stock comes back only when the tablets go back on the shelf.
6. **Which product fills a prescription:** any of the facility's stock items for the prescribed generic (a brand, a pack). The batch is chosen earliest-expiry-first, and the pharmacist may override it with a reason. The quantity defaults to the prescribed one where the item's base unit is the dose unit; otherwise the pharmacist enters it (one bottle). Another generic needs a new prescription. **An expired batch is never dispensed**, by default or by override; it waits to be written off (3b).
7. **Not supplied:** the pharmacist marks a medicine not supplied, with a reason (out of stock, patient declined, will buy elsewhere, or other with text). That ends it without a charge, so the visit can close. It is final for that medicine.
8. **The controlled-drug register's contents** still wait on PPB's answer (`SPEC.md` §4, question 7). Until then: date, patient, prescriber and licence, item, batch, quantity in and out, running balance, and who dispensed. A wrong entry is corrected by a reversing entry, never edited. **One register per catalogue drug and store**, not per stock item: a paper register keeps a page per drug, form and strength, so two brands of morphine 10 mg/mL share one running balance.
9. **Stock takes: blind.** The counter does not see the expected quantity until the count is submitted. The store does not freeze: each line's expected quantity is the sum of movements up to the moment it was counted. Each variance is an adjustment approved by a second person. A count covers a whole store or a chosen list of items, since a full count of a main store can take days.
10. **Alerts:** an in-app list for the pharmacy and stores, as for break-glass. A batch is flagged 90 days before it expires, and an item when it falls below its store's reorder level. The 90 days is fixed in v1, not a setting.
11. **Consumables on orders** (deferred from P3 slice 4a): stock items that are not drugs, charged when issued against an order item (a crepe bandage for a dressing). Stock for a ward or a department goes by transfer and is charged to no patient. Ward issues per inpatient wait for P5's medication administration record.
12. **Medicines that disclose a condition** (left to P4 by P3 slice 7: an HIV medicine prescribed outside a sensitive clinic is not hidden): decided with slice 3a, dispensing. Slice 1a adds nothing for it until something reads it; bills already print a neutral name.

**Slice 1b, goods received** (decided 2026-11-15, as recommended):
1. **Who receives:** storekeepers, pharmacists and pharmacy technicians. It is not a clinical act, so no licence is asked.
2. **A goods-received note per delivery:** the store, the supplier as text, the supplier's delivery-note or invoice number, the date received, and its lines: item, batch number, expiry, quantity and the line's total cost. A quantity is given in whole packs or in loose units, and stored in base units with the pack size it was received at.
3. **Numbered** from a yearly `GRN-` series (`GRN-2026-000123`). No printed document in v1.
4. **Each line is its own batch**, carrying the supplier's batch number and expiry, so its cost is exact. Two deliveries of one supplier batch are two batches with the same number, which earliest-expiry-first handles.
5. **Expiry:** required for a drug, optional for a consumable. An expired batch is refused; one expiring within 90 days is taken with a warning. A drug's batch number is required too, a consumable's optional.
6. **A cost of zero** is allowed, for donated stock, with the donor as the supplier.
7. **A mistyped line** is reversed as a whole, with a reason, while none of its stock has moved. Anything later is an adjustment (3b, second person).
8. **Into any active store**, since a small hospital may receive straight into its pharmacy. A store or item still holding stock cannot be retired.
9. **The stock view:** each store's items with stock or a reorder level, on hand, batches by expiry (expired ones marked) and value at cost. Read by stock keepers, pharmacy technicians, the finance manager and the auditor.

**Slice 1c, item import** (decided 2026-11-15, as recommended):
1. **The file** is this system's own CSV: `code,name,category,drug_code,base_unit,pack_size,unit_price`, one row per item, `category` `drug` or `consumable`, `unit_price` per base unit in shillings with up to two decimals. At most 5,000 rows.
2. **A preview first**, writing nothing: every problem in the file, and for a drug row with no `drug_code` up to three catalogue drugs its name suggests. The import itself needs every drug row matched: the system never guesses a drug.
3. **Run by the facility admin**, since it creates billable items as well as stock items.
4. **Prices** go into one price change, effective from the import's day unless a later one is given, for the finance manager to approve (rule 24). A row with no price leaves the item unpriced, so it cannot be dispensed until it is priced.
5. **All or nothing:** one bad row refuses the file, and the report lists every bad row.
6. **Running it again changes nothing:** a code already set up is matched, not duplicated, and its price is requested only if it differs from today's. A row that disagrees with what is there (another category, drug, base unit or pack size) is refused, never applied; an existing item keeps its name.
7. **Reorder levels are not in the file**; they are set per store. Opening stock waits for P6.

**Slice 2, transfers** (decided 2026-11-15, as recommended):
1. **Request, send, receive.** Approving and sending are one act by the sending store's staff; a store may also send without a request (the main store topping up a ward). The pilot's answer on who approves ward transfers (`SPEC.md` §9, question 9) may add an approval step.
2. **Batches:** the sender picks them, earliest expiry first unless they choose. Stock leaves the sending store when sent and enters the receiving store when received; on the way, it shows on the transfer and in neither store.
3. **A shortfall** is entered per batch on receipt, with a reason; more than was sent is refused. A second person (the finance manager or a pharmacist, never the receiver) accepts the loss; until then the transfer shows short, awaiting approval. One receipt per transfer: what is still to come is a new transfer.
4. **Who:** storekeepers, pharmacists and pharmacy technicians request, send and receive, for any store; nurses and ward nurses request for and receive into a ward's store only. **One person cannot both send and receive a transfer.**
5. **Numbered** from a yearly `TRF-` series. No printed issue voucher in v1.
6. **Less may be sent** than was asked for; no back-orders, so the rest is a new request.
7. **Before it is sent**, the requester may cancel a request and the sending store may decline it, each with a reason. Once sent, a transfer is only received.
8. **An expired batch is never sent**; it is written off where it is (3b).
9. **Controlled drugs:** nothing special yet; slice 4 writes their register entries for transfers as for dispensing, before anything is live (P6).

**Slice 3a, dispensing** (decided 2026-11-15, as recommended; P4 questions 4–7 already applied):
1. **The pharmacy's list is the facility's**; the pharmacist dispenses from a store of kind `pharmacy`, the facility's only one unless they name another.
2. **A dispense is one prescription handed over**, a line per medicine, each line drawing on as many batches as it needs. A medicine may be given part now and the rest later, until its quantity is met or the rest is marked not supplied.
3. **Preparing raises one charge per line**: the item's cash price per base unit times the quantity, rounded to whole shillings once (D2).
4. **The quantity**, where the item's base unit is the prescription's dose unit, defaults to what is still owed and may not exceed it. Where the units differ (a 100 mL bottle for 75 mL), the pharmacist gives it.
5. **A medicine is finished** when its quantity is met, or, in other units, when the pharmacist marks its line as completing it; either way its rest may be marked not supplied.
6. **Open visits only.** The nightly close takes a visit with undispensed medicines off the list, which then show as never dispensed. A visit no longer finishes early while a medicine is neither dispensed nor marked not supplied.
7. **Cancelling a prepared dispense** returns its stock and cancels its charges while none is billed; once billed, it is a return (3b).
8. **Inpatients** are dispensed the same way until P5's ward stock and medication administration record.
9. **No dispensing label** in 3a; it needs label printers.
10. **Medicines that disclose a condition** (question 12) become their own slice, **3c**, after 3b: the facility admin marks catalogue drugs sensitive, and a prescription of one is restricted as a sensitive lab test restricts its order. It changes P3's prescriptions, so it is not folded into dispensing.

**Slice 3b, returns and adjustments** (decided 2026-11-15, as recommended):
1. **A patient returns** only what was handed over, no more than was given less what has come back already. It goes back to the pharmacy it left, into the latest-expiring of the batches it came from; an expired batch takes nothing back.
2. **The pharmacist judges a return fit to sell again.** One that is not puts nothing back on the shelf, and is a write-off: a second person approves it before the patient is credited.
3. **Unbilled**, the line's charge is cancelled and a new one raised for what the patient kept, at the original price (charges are cancelled, never edited).
4. **Billed**, the return asks for a credit note on the invoice through the existing adjustments, which a second person approves; money already paid goes back through the existing refunds.
5. **Stock adjustments** are `expired`, `damaged`, `lost`, `found` or `correction`, each with a reason, naming batches and quantities; one request may cover many batches (every expired batch in a store). `found` stock goes into an existing batch only: new stock comes by goods received.
6. **Stock moves only on approval**; a pending request leaves the shelf as it is.
7. **Store staff ask; the finance manager or a pharmacist approves**, never the person who asked (rule 24, a `CHECK` as well as the service). No value threshold in v1.
8. **Each adjustment carries its value** at the batch's cost, for the loss report.
9. **A controlled drug** is returned or adjusted only by a pharmacist with a pharmacy licence, as it is dispensed; its register entries come with slice 4.

**Slice 3c, sensitive medicines** (decided 2026-11-15, as recommended; question 12):
1. **The facility admin and pharmacists** mark a catalogue drug HIV, mental health or GBV, per strength and form.
2. **A prescription naming a marked drug is restricted as a whole**, as a sensitive lab test restricts its order: clinicians' order views and the printed prescription. The pharmacy still sees and dispenses it (P3 slice 7).
3. **Past prescriptions follow the mark**, as for a lab test; unmarking lifts it.
4. **Bills are untouched**: the item's neutral printed name is set with the existing route.
5. **Nothing is shipped**: the pilot's clinician supplies the drugs, with the sensitive ICD-11 codes still owed.
6. **Marking and unmarking are audited** with the old and new category.

**Slice 4, the controlled-drug register** (decided 2026-11-16, as recommended; contents per question 8 until PPB answers):
1. **Every movement of a scheduled drug writes a line**, in any store: receipts and their reversals, transfers, dispensing and its cancellation, returns and approved adjustments, each in the movement's own transaction.
2. **The database writes it**: a trigger on the stock ledger, so no path moves a controlled drug unrecorded; one drug's lines in a store are written one at a time.
3. **Each line keeps its running balance**, a snapshot for the legal record like the paper register's column, checked daily against the ledger by the reconciliation job, which alerts on drift.
4. **A line keeps** the movement, the batch and, for a dispense or return, the patient; it copies the prescriber's and dispenser's licence numbers as they were. The patient's name and number are shown from the record.
5. **No hand entries**: a wrong line is corrected by the movement that corrects the stock, which writes its own.
6. **Stock held before a drug was scheduled** is brought forward on its first line.
7. **Read by** pharmacists, the facility admin and the auditor, audited, as lines name patients.
8. **`GET /controlled-register`** shows one drug in one store over a range of days; printing comes with P6's reports.
9. **Opening balances at go-live** come from the old register's closing balance, at P6's cutover.

**Slice 5, stock take** (decided 2026-11-16, as recommended; question 9 applied):
1. **The count sheet** lists every batch the store holds of the items counted (the whole store, or chosen items); the counter may add another of the facility's batches found on the shelf.
2. **Blind:** the counter never sees what is expected; once the count is submitted, anyone who reads stock takes does. A nurse reads the counts of ward stores only (refined 2026-11-17 after CodeRabbit on #22).
3. **Each line records when it was counted**; what is expected is every movement committed at that moment, read as the count is recorded, so stock moving during the count does not skew it (refined 2026-11-16 after CodeRabbit on #22: a timestamp cutoff counted a movement still open at the count).
4. **Every line is counted** (zero allowed) before the count is submitted.
5. **Submitting raises one stock adjustment** (`correction`) for the differences, linked to the stock take, for the finance manager or a pharmacist other than the counter to approve. Each line moves by its difference, so it stays right though stock moves before approval.
6. **Who counts:** storekeepers, pharmacists and pharmacy technicians; nurses for a ward's store only.
7. **A count with a controlled drug** is submitted by a pharmacist with a pharmacy licence, as such an adjustment is asked for.
8. **Expired batches are counted**; writing them off is its own adjustment.
9. **One open count per store**, numbered from a yearly `STK-` series. None opens while the store's last correction waits (added 2026-11-16 after CodeRabbit on #22), as it would ask for the same difference again.

**Slice 6, alerts and the exit** (decided 2026-11-16, as recommended; question 10 applied):
1. **Computed when read, not by a nightly job.** `GET /stock-alerts` works the list out from the ledger each time it is opened, so it is never a night behind and holds no state. The "Expiry scan, low stock" job in `CLAUDE.md` §7 is dropped; a nightly SMS or email of the list can come later through the outbox if a pilot asks.
2. **Three lists:** batches past their expiry still held, to write off; batches expiring within 90 days; and items **strictly below** their store's reorder level, so a level of nought flags nothing. An item a store holds none of is flagged when it has a level there.
3. **Stock in transit** to a store (sent, not received) is shown beside a low item, not counted towards it: it is not on the shelf yet.
4. **No dismissing:** an alert lasts while its cause does. Writing a batch off, moving it, or restocking clears it.
5. **Read by** stock readers (the facility admin, pharmacists, pharmacy technicians, storekeepers, the finance manager and the auditor), per store or for all. They hold no patient data, so reads are not audited.
6. **The exit:** the OPD journey test takes Amina's prescription through the pharmacy (prepared, paid, handed over) in place of "not supplied". A scripted pharmacy test checks, for every store and batch, that on hand is the sum of movements and never negative, and that every controlled-drug register page balances. The certification pack's clinical functions gain the pharmacy.

### P5 · Inpatient clinical

**Size:** L. **After P6** (reordered 2026-11-17, §1): the pilot has no inpatient service yet.

Bed board; transfers; nursing notes; observation charts, with the NEWS2 early-warning score for adults (moved here from P3 on 2026-11-10: it is built for spotting deterioration on the wards, and outpatient triage uses the emergency/urgent/routine priority instead); the medication administration record (MAR); ward rounds; the discharge summary.

**Exit:** admission to discharge with a signed discharge summary and no paper.

### P6 · Pilot go-live (cash)

**Size:** M.

Everything the pilot needs to leave its current system on one day. The pilot is outpatient only (reordered 2026-11-17, §1), so this follows the frontend's outpatient screens, not P5:

- **The outpatient screens** (§1, steps F1–F3), which every item below is used through.
- **Consumables on orders** (P4 question 11) were decided and not built: a dressing's bandage is charged today by manual posting, with a reason. The pilot's staff asked for both, item by item or not (the staff walkthrough, 2026-11-20). The owner left it for later, so it is not built before go-live.

- **Migration tooling**, built to be reused by later hospitals: patients and legacy numbers (`SCHEMA.md` §6), open balances and deposits.
  - **At the pilot's cutover:** its old records are on paper and it starts afresh, so the owner left the patient import for later (2026-11-20).
  - Whether it has open balances or deposits to bring over is still to be asked. The hospital is new, so the volume is small either way.
- **Opening stock**, from a physical count on cutover day: per store and batch (batch number, expiry, quantity, cost), loaded as `opening_balance` movements (`SCHEMA.md` §8). Controlled drugs also get an opening entry in their register, matching the old register's closing balance. Without this, stock on hand would be zero on day one and nothing could be dispensed.
- **Reports a facility must file or run daily:** MOH 705A/705B and 717, revenue and cashier summaries, stock status.
- **PWA offline support** at the service points that need it.
- ~~**M-Pesa hardening before real money.**~~ Done (decided 2026-11-20): a paybill belongs to one facility; the facility admin replaces a leaked callback token, the old one taking only prompt outcomes sent before and keeping paybill payments for a person, until the new URLs are registered and an hour after; finance replays a prompt callback that could not be recorded (`SCHEMA.md` §7.4). As first written: A way for the facility admin to rotate a leaked callback token: a new token, its URLs registered with Safaricom, and the old one kept for a short grace period so callbacks for prompts already sent still land. In that period the old token must accept only callbacks for prompts sent before the rotation, never paybill confirmations, or a leaked token keeps working for its whole length. A way to recover a prompt callback kept as "Could not be recorded" (its own transaction failed, and Safaricom does not call again): replay it with the first attempt's safeguards, or put its payment in the queue. And a decision: may two facilities (a hospital group's branches) share one paybill? Today nothing stops it, but Safaricom registers one set of callback URLs per paybill, so the second registration takes all its confirmations. Either refuse a shortcode another facility holds, or route by account reference. Found in the full review of PR #9.
- **Backups and a disaster-recovery drill**, and a security review before real patient data arrives.
- ~~**Migrations that are safe on live data.**~~ Done for audit actions (decided 2026-11-15, the chore PR after #17): they are rows of `audit_actions`, referenced by a foreign key, so a new action is an insert and never touches `audit_log`. The drizzle migrator still applies all pending migrations in one transaction. A CHECK on another large table (outbox operations, charge statuses) still re-scans it when it changes; those change rarely, and one that must change on a large live table gets a one-off deploy step rather than a migrator of our own. Found in review of PR #4.
- **Training and the simplicity test** (`SPEC.md` §7.9): new staff in each role do their daily tasks after one short session, watched and timed. Where they get stuck is fixed before go-live.
- **The tariff before the first patient:** every ward's bed-day item set and the cash tariff approved before cutover, because prices are never backdated and a night before its price can never be charged (`SCHEMA.md` §7.2).
- **Legal clearance** from P0: written confirmation that the pilot may run this system before certification.

**Exit:**
- The pilot runs its outpatient services entirely on this system for cash and M-Pesa patients, with the old system switched off.
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
