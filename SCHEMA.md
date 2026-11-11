# Schema Design

Status: proposed · Last updated: 2026-11-03

`SPEC.md` is the source of truth for decisions and open questions; `CLAUDE.md` holds the conventions code must follow; `ROADMAP.md` orders the work. This document covers the data model.

- Patient numbering (§5–§6) is designed in detail.
- The money model (§7) and payers and claims (§9) are designed to the level of tables, key columns and invariants, because every other module depends on them.
- Everything else is an entity map with the rules each table must carry.

---

## 1. Decided

- **The tenant is one facility** (`facility_id`): one KMHFR facility code, one SHA contract. Hospital groups with several branches are later (see `SPEC.md` D6).
- Patient numbers are **auto-generated and sequential**, per facility.
- Each facility **chooses its own prefix** per series, e.g. `OP` for outpatient and `IP` for inpatient.
- The **IP number is issued once per patient and linked to their OP number**. It is not issued per admission; each admission gets its own admission number (§6.1).

## 2. Assumptions to confirm

- The OP number is issued at registration. The IP number is issued at the patient's first admission.
- The zero-padded width is configurable per series, default 4 (`OP0001`).
- A facility may change its prefix later. The change applies to newly issued numbers only.
- ~~The `sex` option set needs confirming.~~ **Confirmed 2026-11-04:** `male`, `female`, `intersex`; blank only for an unidentified patient (§5.1).
- ~~The bed-day counting rule.~~ **Decided 2026-11-04:** midnight census, minimum one day (§7.2). To confirm with the pilot.

---

## 3. Entity map

Every table carries `facility_id` except the shared reference group.

| Module | Tables |
|---|---|
| Tenancy and access | `facilities` (kmhfr_code, level, SHA contract ref), `memberships` (roles[], licence number and expiry; cadre and council derived, §8), `departments`, `service_points`, `number_series`, `audit_log`, `outbox`, `job_failures`, `files` |
| Shared reference (no `facility_id`; read-only to the app role) | `icd_codes`, `drug_catalogue`, `sha_tariffs` (versioned), `payer_registry` |
| Patients | `patients`, `patient_numbers`, `patient_identifiers` (incl. SHA number, client-registry ID), `patient_contacts` (next of kin; guardian for minors), `patient_alerts` (allergies and similar), `consents` |
| Encounters | `encounters` (opd \| ipd \| emergency), `appointments`, `queue_entries`, `observations`, `diagnoses`, `clinical_notes`, `orders`, `order_items`, `procedures_performed` |
| Inpatient | `wards`, `beds`, `admissions`, `bed_stays`, `medication_administrations`, `discharge_summaries` |
| Lab | `lab_tests`, `specimens`, `lab_results` |
| Pharmacy and stores | `inventory_items`, `stores`, `stock_batches`, `stock_movements`, `stock_transfers`, `goods_received`, `dispenses`, `controlled_drug_register` |
| Billing | `billable_items`, `price_lists`, `price_list_items`, `charges`, `accounts`, `invoices`, `invoice_lines`, `charge_assignments`, `invoice_adjustments`, `payments`, `mpesa_transactions`, `allocations`, `refunds`, `cashier_shifts` |
| Payers and claims | `payers`, `payer_schemes`, `patient_coverages`, `encounter_coverages`, `eligibility_checks`, `preauthorizations`, `claims`, `claim_items`, `gateway_exchanges`, `remittances`, `remittance_lines` |

A **visit** in the earlier clinic design is an OPD encounter. A **prescription** is a medication order; the printed prescription is its frozen snapshot (rule 7).

---

## 4. Conventions that apply (see `CLAUDE.md` section 3)

- `facility_id` on every tenant table, with RLS policies and composite foreign keys `(facility_id, id)`. The Drizzle sketches below use simple references for readability; the real tables must use the composite form.
- Text columns typed with `.$type<...>()` carry a matching `CHECK`.
- Nothing hard-deletes. Phone numbers are E.164. Dates are `date`; instants are `timestamp`.
- No patient data in URLs, logs, Redis keys, queue payloads, or object keys.
- Typed nullable foreign keys plus `CHECK (num_nonnulls(...) = 1)`, never a polymorphic `source_type` / `source_id` pair (rule 22).

---

## 5. Tables (Drizzle sketch): patient numbering

```ts
// One counter per facility per series. Extending `kind` later (e.g. 'invoice', 'receipt')
// lets the same table issue gap-free sequential numbers for financial documents (§6.1).
export const numberSeries = pgTable('number_series', {
  id: uuid('id').primaryKey().defaultRandom(),
  facilityId: uuid('facility_id').notNull().references(() => facilities.id),
  kind: text('kind').$type<'outpatient' | 'inpatient'>().notNull(), // + oneOf CHECK
  prefix: text('prefix').notNull(),                  // 'OP', 'IP'
  padding: integer('padding').default(4).notNull(),  // OP0001; grows past the width, never truncates
  nextValue: integer('next_value').default(1).notNull(),
}, (t) => [unique().on(t.facilityId, t.kind)]);

export const patients = pgTable('patients', {
  id: uuid('id').primaryKey().defaultRandom(),
  facilityId: uuid('facility_id').notNull().references(() => facilities.id),

  // Kenyan names do not split reliably into a fixed given/surname order
  givenName: text('given_name').notNull(),
  middleNames: text('middle_names'),
  familyName: text('family_name').notNull(),

  dateOfBirth: date('date_of_birth'),
  dobIsEstimated: boolean('dob_is_estimated').default(false).notNull(),
  sex: text('sex').$type<'male' | 'female'>(),       // confirm the option set
  phone: text('phone'),                              // E.164

  status: text('status').$type<'active' | 'inactive' | 'deceased'>().notNull(), // + CHECK
  mergedIntoId: uuid('merged_into_id'),              // duplicate merges: point, never delete
  registeredAt: timestamp('registered_at').defaultNow().notNull(),
}, (t) => [
  index().on(t.facilityId, t.familyName),
  index().on(t.facilityId, t.phone),
]);

// One row per number issued to a patient. The OP row and the IP row share a patient_id,
// which is what "linked with the OP" means.
export const patientNumbers = pgTable('patient_numbers', {
  id: uuid('id').primaryKey().defaultRandom(),
  facilityId: uuid('facility_id').notNull(),
  patientId: uuid('patient_id').notNull().references(() => patients.id),
  kind: text('kind').$type<'outpatient' | 'inpatient'>().notNull(), // + oneOf CHECK
  number: text('number').notNull(),                  // frozen text, e.g. 'OP0042'
  issuedAt: timestamp('issued_at').defaultNow().notNull(),
}, (t) => [
  unique().on(t.facilityId, t.number),               // no two patients share a number
  unique().on(t.patientId, t.kind),                  // at most one OP and one IP number per patient
]);

export const patientIdentifiers = pgTable('patient_identifiers', {
  id: uuid('id').primaryKey().defaultRandom(),
  facilityId: uuid('facility_id').notNull(),
  patientId: uuid('patient_id').notNull().references(() => patients.id),
  type: text('type')
    .$type<'national_id' | 'passport' | 'birth_certificate' | 'sha_number' | 'client_registry_id' | 'other'>()
    .notNull(),                                      // + oneOf CHECK
  value: text('value').notNull(),
}, (t) => [index().on(t.facilityId, t.type, t.value)]); // index, not unique: warn on duplicates instead
```

`client_registry_id` is the national Client Registry identifier. Its name and format are to be verified with DHA (`SPEC.md` §10).

### 5.1 As built (P2, slice 1)

Decided 2026-11-04 with the product owner:

- **Required at registration:** given and family names, sex, a date of birth or an estimated age, a phone number, and an identity document (`national_id`, `passport`, `birth_certificate`, `alien_id` or `refugee_id`; an SHA number alone does not count).
  - A phone or a document may be missing only with a stated reason: `no_phone_reason` (`no_phone` | `unidentified`), `no_id_reason` (`none_held` | `not_carried` | `unidentified`). The database enforces "a phone or a reason, never neither, never both". Records with a reason are the follow-up list.
  - An **unidentified** emergency patient (`unidentified = true`) carries placeholder names and may have no sex recorded until identified. `unidentified` reasons are allowed only on such a patient, and identifying them requires the reasons to be replaced in the same edit.
- **Sex** is `male` | `female` | `intersex`.
- **An estimated age** is stored as the date of birth it implies (today's Kenyan date, that many years earlier), with `dob_is_estimated`.
- **Identifier types** add `alien_id` and `refugee_id` to the sketch above. Values are stored uppercase without spaces or dots. Identifiers are insert-only for the runtime role; marking one entered in error is a follow-up.
- **Duplicates warn, never block.** Registration (and adding an ID) answers 409 with the likely matches: the same identity number, the same family name and phone, or the same names and date of birth. The clerk opens the existing record or confirms it is someone else (`confirmNotDuplicate`, recorded in the audit entry). Merging is a later slice.
- **Search** matches an OP or IP number (exact, any case), a phone in any format, an ID number, or names (each word typed matches the start of one of the patient's names). It returns at most 20 matches and is rate limited per person. Looking up a number without its prefix is still the open question in §11.
- **Reads are audited** (rule 9): every search (with its query) and every opening of a record. Corrections record each changed field's old and new value.
- **Roles:** `records_clerk`, `nurse` and `facility_admin` register and correct; every member may search and open a record.
- The runtime role holds `SELECT`, `INSERT` and a column-level `UPDATE` on demographics only; `patient_numbers` and `patient_identifiers` are insert-only.

---

## 6. Issuing numbers

Allocate inside the same transaction that creates the patient (OP) or admits them for the first time (IP):

```ts
async function issuePatientNumber(
  tx: Tx, facilityId: string, patientId: string, kind: 'outpatient' | 'inpatient',
) {
  // Idempotent: a patient has at most one number per kind.
  const [existing] = await tx.select().from(patientNumbers)
    .where(and(eq(patientNumbers.patientId, patientId), eq(patientNumbers.kind, kind)))
    .limit(1);
  if (existing) return existing.number;

  const [row] = await tx.update(numberSeries)
    .set({ nextValue: sql`${numberSeries.nextValue} + 1` })
    .where(and(eq(numberSeries.facilityId, facilityId), eq(numberSeries.kind, kind)))
    .returning({
      prefix: numberSeries.prefix,
      padding: numberSeries.padding,
      issued: sql<number>`${numberSeries.nextValue} - 1`,
    });

  const number = `${row.prefix}${String(row.issued).padStart(row.padding, '0')}`;
  await tx.insert(patientNumbers).values({ facilityId, patientId, kind, number });
  return number;
}
```

Rules and reasoning:

- **A counter row, not a Postgres sequence.** The row lock serializes concurrent registrations per facility and series, which is fine at hospital scale. Because it is in the same transaction as the insert, a failed registration does not burn a number. Native sequences are not transactional (a rollback leaves a gap), and per-facility sequences would need dynamic DDL.
- **Constraints are the backstop.** `unique(facility_id, number)` prevents duplicates. `unique(patient_id, kind)` means that if two requests try to issue the same patient's first IP number at once, the second fails and rolls back, taking its counter increment with it. The caller then re-reads the existing number.
- **Issued numbers are frozen text.** Never rebuild a number from the current prefix.
- **Prefix changes apply going forward.** The counter keeps counting, so the numeric part never repeats within a series.
- **Onboarding needs a start value.** A hospital moving from a paper register continues from its current number. Import legacy numbers as-is (free text), and set the counter above the highest legacy number so generated numbers cannot collide.
- **Merging duplicate patients.** Set `merged_into_id` on the duplicate; never delete. The duplicate's numbers keep resolving by following the pointer, and numbers are never reused.
- **Sequential means guessable.** Never put a patient number in a URL or treat it as a secret. URLs use the UUID; the number is for humans and search. Access is protected by RLS, roles, and the audit log (including reads).
- **Register the series at facility onboarding.** Create the OP and IP series when a facility is created, with the facility's chosen prefixes.

### 6.1 Generalised series (documents and accessions)

The same counter issues every human-facing sequential number:

| Kind | Example | Reset period | Gap-free? |
|---|---|---|---|
| `outpatient`, `inpatient` | `OP0042`, `IP0007` | never | yes |
| `admission` | `ADM-2026-0153` | yearly | yes |
| `invoice`, `receipt`, `credit_note`, `refund` | `INV-2026-004211` | yearly | **yes: fiscal documents** |
| `lab_accession` | `L-20261103-017` | daily | no (a rejected specimen keeps its number) |
| `grn`, `transfer` | `GRN-2026-0091` | yearly | yes |

- **As built (P1), the configuration and the count are separate tables.** `number_series` holds one row per `(facility_id, kind)` with `prefix`, `padding` and `reset_period` (`never` \| `yearly` \| `daily`). `number_series_counters` holds one row per `(series_id, period_key)` with its `next_value`, where `period_key` is `'all'`, `'2026'` or `'2026-11-03'`, computed in Africa/Nairobi (rule 26). So a prefix change applies going forward without touching a count, and a new period needs no configuration copied. The counter for a new period is created on first use with `INSERT … ON CONFLICT DO NOTHING`, then locked as above (`src/lib/number-series.ts`). The §5 sketch keeps the single-table form for readability.
- A number with a period carries it: prefix, period, `-`, padded value. So `ADM-` yearly gives `ADM-2026-0153`, and `L-` daily gives `L-20261103-017`.
- Kinds are added to the `kind` CHECK as the modules that issue them land. P1 registers `outpatient` and `inpatient` at onboarding.
- **Fiscal numbers are issued at finalisation**, in the same transaction that freezes the document, never at draft (rule 20). A draft invoice has no number. A voided document keeps its number, so the sequence has no gaps an auditor must explain.
- The counter lock serializes finalisations per facility and kind. This is acceptable because finalisation is fast and does no external I/O (rule 18). A SHA call must never run while the lock is held.

### 6.2 Printed documents (as built, P1)

Every printed, numbered document goes through one table, `documents`. The module whose work it records (payments for a receipt, billing for an invoice) issues it in the same transaction that finalises that work, by calling `issueDocument` (`src/lib/documents.ts`):

1. It takes the number from the facility's series of the same `kind` (§6.1, rule 20).
2. It mints a `verification_code`: 160 random bits, base64url, the payload of the QR printed on every page.
3. It freezes `content`: exactly what is printed (title, label and value pairs, a table, totals, notes, all as formatted text), plus the facility's name and KMHFR code as they are at that moment (rule 7). The PDF is rendered from `content` and nothing else, so a reprint years later says what the original said.
4. It records the issuing membership in `issued_by` (rule 25) and writes `document.issued` to the audit log.

| Column | Notes |
|---|---|
| `kind` | `receipt` so far. Kinds are added to the CHECK as the modules that issue them land; each needs a number series of the same kind |
| `number` | Unique per `(facility_id, kind)` |
| `verification_code` | Globally unique; `CHECK` holds the 27-character shape |
| `content` | jsonb, validated by `documentContentSchema` (`src/lib/document-content.ts`) |
| `issued_at`, `issued_by` | `issued_by` → `memberships (facility_id, id)`; null when the system issued it |
| `voided_at`, `void_reason` | Both or neither; the reason is never shown publicly |

- **Modules point at their document**, never the reverse: a receipt row will carry `document_id` with a composite foreign key to `documents (facility_id, id)`. So the document's number and code live on the document row, and no polymorphic reference is needed (rule 22). This replaces the `number` column the §7 sketches put on invoices and adjustments.
- **Frozen by a trigger** (`documents_frozen`, migration 0006) for every role, the owner included: a document is inserted standing, never already voided; the only change allowed is voiding once (setting `voided_at` and `void_reason`); a voided document never changes again; and no document is deleted. The runtime role holds `SELECT`, `INSERT` and `UPDATE (voided_at, void_reason)` only.
- **Voiding** (`voidDocument`) is done by the module whose correction made the document untrue, in the same transaction as that correction. The PDF then prints VOID across it.
- **Printing:** `GET /documents/{id}/pdf`. Who may open a document depends on its kind (`DOCUMENT_READERS`). Each opening writes `document.viewed` on the request transaction, so a failed render leaves no entry (rule 9).
- **Public verification:** `GET /verify/{code}`, with no session and no facility, rate limited per address. It answers only the kind, title, number, issue time, the issuer as printed, and whether the document still stands (`valid` or `withdrawn`): nothing about the patient, and not when or why it was voided. Each check writes `document.verified`, with no actor, to the issuing facility's audit log. The QR opens the staff app's page at `{APP_URL}/verify/{code}`, which calls this endpoint.

---

## 7. The money model

Money moves at four levels: **charge → invoice → claim → remittance**. Each level has its own job and its own invariant. Collapsing two of them is the most common way hospital billing systems end up with two answers to "what is owed".

| Level | Question it answers | Table |
|---|---|---|
| Charge | What did the hospital do for this patient, at what price? | `charges` |
| Invoice | Who is asked to pay which part of it? | `invoices`, `invoice_lines`, `charge_assignments` |
| Claim | What did we ask a payer for, and what did they approve? | `claims`, `claim_items` (§9) |
| Remittance / payment | What money arrived, and what did it settle? | `payments`, `allocations`, `remittances` (§9) |

### 7.1 Accounts: who owes

```ts
// A debtor. Every invoice, payment, allocation, adjustment and refund belongs to exactly one.
export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  facilityId: uuid('facility_id').notNull(),
  kind: text('kind').$type<'patient' | 'payer'>().notNull(),        // + oneOf CHECK
  patientId: uuid('patient_id'),
  payerId: uuid('payer_id'),
}, (t) => [
  // exactly one owner, and it matches the kind
  check('accounts_one_owner', sql`num_nonnulls(${t.patientId}, ${t.payerId}) = 1`),
  check('accounts_kind_matches', sql`(${t.kind} = 'patient') = (${t.patientId} IS NOT NULL)`),
  unique().on(t.facilityId, t.patientId),
  unique().on(t.facilityId, t.payerId),
]);
```

Rule 6 becomes the **debtor-account rule** (invariant M1). Invoices, payments, allocations, adjustments and refunds all carry `account_id`. Their references to each other are three columns wide, `(facility_id, id, account_id)`. This is the same pattern school-saas uses with `student_id` on allocations. A patient's deposit allocated to SHA's invoice cannot be stored at all, so no code has to remember to refuse it.

### 7.2 Charges: what was done

Captured at source by the module that did the work, never typed in at the cashier (rule 16). Manual posting exists for the gaps, needs a reason, and is audited.

| Column | Notes |
|---|---|
| `encounter_id` | Every charge belongs to an encounter (OPD visit or admission) |
| `billable_item_id` | The facility's catalogue item (consultation, test, drug, bed-day, procedure) |
| source: `order_item_id` \| `dispense_id` \| `bed_stay_id` + `charge_date` \| `procedure_performed_id` | Typed nullable FKs, `num_nonnulls(...) <= 1`; zero sources means a manual posting, which requires `manual_reason` |
| `quantity`, `unit_price_cents`, `amount_cents` | Snapshotted at capture (`SPEC.md` D3). The unit price may carry fractional shillings; the amount is rounded to whole shillings once, here (D2) |
| `price_list_item_id` | Which price was used, for audit and re-pricing |
| `service_date` | `date`, in Africa/Nairobi |
| `captured_by` | Membership |
| `cancelled_at`, `cancellation_reason` | A charge can be cancelled only while it is unassigned (M4) |

**Pricing basis.** One function prices every charge: `resolvePrice(item, scheme, serviceDate)` (rule 21). It looks in the scheme's price list, then the payer's default list, and otherwise answers **not covered**. It never falls back to the cash price on a payer's bill. The cash list applies only to the patient account. `price_list_items` cannot have overlapping effective ranges for one item (an `EXCLUDE` constraint).

- **Itemised schemes** (most private insurers) price each charge from their own list.
- **Package schemes** (SHA per-diem and surgical packages: verify the package structure) price charges at the facility's gross tariff. The money is recovered through package lines that absorb those charges (§7.3).
- Items not covered by the encounter's billing plan are priced from the cash list and land on the patient account.

Re-pricing an encounter (for example, coverage confirmed after the charges were captured) is an explicit, audited act. It applies only to unassigned charges.

**As built (P2, slice 3): the catalogue and prices.**

- `billable_items`: the facility's own `code` (uppercase, never changes, printed on bills), `name`, `category` (consultation \| bed_day \| lab \| imaging \| procedure \| drug \| consumable \| service \| other). Identity only.
- `price_lists`: one `cash` list per facility (created at onboarding, backfilled for existing facilities). Payers' lists join it in P7.
- `price_list_items`: one item's price on one list from `valid_from` until `valid_to` (exclusive, open when null). An exclusion constraint forbids two overlapping prices for one item on one list. A trigger lets `valid_to` only move earlier and never reopens it, and no other column changes.
- **Price changes need a second person (rule 24).** `price_changes` (pending \| approved \| rejected \| withdrawn) carry `price_change_lines`; a CHECK requires the approver or rejecter to differ from the requester, and only the requester may withdraw. A decided change is frozen by a trigger. One request may carry a whole tariff, so a facility's first prices are one approval.
- **Applying a change** from day E: the price running into E ends on E; a price already approved to start on or after E ends on its own start, so it never applies; the new price runs from E. E must be today or later at request and at approval. The approval's audit entry records each item's old and new price.
- **`resolvePrice(item, list, serviceDate)`** (`src/lib/prices.ts`) is the only lookup. In P2 the list is the cash list; P7 adds the scheme and payer lists in front of it, and keeps "not covered" as the answer when none has the item.
- The facility admin and the finance manager keep the catalogue and request and approve changes; every member reads prices.

**As built (P2, slice 3): charges and bed-days.**

- `charges`: `encounter_id`, `billable_item_id`, `quantity` (numeric, 3 decimals), `unit_price_cents` and `amount_cents` copied at capture, `price_list_item_id`, `service_date`, one typed source (`bed_stay_id` so far) or a `manual_reason`, `captured_by` (null for a system capture), and cancellation columns (all-or-none, with a reason). `amount_cents` is a whole number of shillings (CHECK), computed once by `chargeAmountCents` (`src/lib/money.ts`, exact, half up). A trigger lets a charge change only by being cancelled, once. An encounter with live charges cannot be cancelled.
- **Manual postings** need a reason, are priced from the cash list for the service date (which must fall within the encounter, not in the future), and are audited. Billing clerks, finance managers and the facility admin post and cancel.
- **Bed-days, by the midnight rule (decided 2026-11-04):** one bed-day for each Nairobi midnight the patient is in a bed, at the rate of the bed-day item of the ward they are in at that midnight, with `service_date` the day the night began. A stay that ended before its first midnight is one day, dated the admission day. A unique index allows one bed-day per encounter per night, and inserts use `ON CONFLICT DO NOTHING`, so `accrueBedDays` is idempotent under repeats and concurrency. Discharge calls it, and so does the nightly run (`POST /internal/jobs/bed-days`, `src/jobs/bed-days.ts`).
- `wards.bed_day_item_id` names the bed-day item a night in the ward is charged as; its price comes from the price list on each night's date. The item is read when the night is charged, not kept per night, so changing a ward's item affects only nights not yet charged: normally the current night, since the run is nightly.
- A night with no item or no price is not charged: it is recorded once in **`job_failures`** (`job`, `subject_id`, `error`, unique while unresolved). The nightly run retries every encounter with an unresolved failure, discharged or not, and marks the failure resolved once nothing it named is missing.
- The nightly run charges each admission in its own transaction, as the visit close does (§8, slice 1b), so one admission that fails leaves the rest charged. Its failure names the admission and is resolved when the admission is next charged without one; a facility whose admissions cannot be listed becomes a failure with no subject, resolved by a later run for that facility with no failure, but not one an overlapping run recorded since (the run's start is read from the database clock, and a failure met again keeps the later `failed_at`).
- **Prices are never backdated**, so a night before its item's first price can never be charged, and its failure stays open for a person to see. Each ward's bed-day item and price are therefore set before the first admission (the P6 cutover, `ROADMAP.md`).

**Bed-days** are derived from `bed_stays` time ranges and turned into charges by one idempotent function. A partial unique index on `(encounter_id, charge_date)` for bed-day charges makes a second run a no-op. The nightly job, the running bill and discharge all call that function, so a missed night is caught up rather than lost.

### 7.3 Invoices: who is asked to pay

| Table | Key columns and rules |
|---|---|
| `invoices` | `account_id`, `encounter_id`, `kind` (interim \| final \| supplementary), `status` (draft \| finalised \| void, lifecycle only, rule 17), `number` (issued at finalisation, §6.1), `total_cents` (frozen from the lines at finalisation), `finalised_at`, `voided_at` + reason. **One live `final` invoice per (encounter, account)** via a partial unique index. |
| `invoice_lines` | `kind` (itemised \| package \| rebill), description and code snapshot, `quantity`, `unit_price_cents`, `amount_cents`. Package lines carry the SHA package/tariff reference. Rebill lines carry `source_adjustment_id` (§7.5). |
| `charge_assignments` | `charge_id`, `invoice_line_id`, `amount_cents`, `mode` (itemised \| absorbed). Splits a charge across accounts: an insurer's 80% and the patient's 20% co-pay are two assignments of one charge. |

- **The running bill** for a long admission is a derived, unnumbered view of charges and their likely split, plus deposit top-up requests. For an admission, numbered interim invoices exist only where a payer requires them (pilot question). An outpatient paying as they go is billed on an interim invoice at each point instead (P3, slice 1c, §8).
- **Package lines absorb charges.** A SHA package line (for example per-diem × days) is linked to the charges it covers through `absorbed` assignments. The contractual allowance (absorbed charges minus the package amount) is **derived, never stored**. Whether the remainder may be billed to a secondary payer or the patient depends on SHA's top-up rules (verify, `SPEC.md` §10).
- An encounter cannot be final-billed while any live charge is not fully assigned (M4).

**As built (P2, slice 4a): accounts and invoices.**

- `payers` is a thin P2 table (name, active), so a payer split can be stored and tested; the app role only reads it until P7 builds payers out. `accounts` is created on first billing (`ensureAccount`, `src/lib/billing.ts`).
- `invoices` carries no `number` column: the number lives on its printed document (`document_id`, §6.2), issued at finalisation from the `invoice` series (`INV-2026-000123`, yearly, six digits). `receipt` (`RCT-`) and `credit_note` (`CN-`) series are registered with it, at onboarding and by backfill.
- `invoice_lines` (`itemised` only in P2) and `charge_assignments` (`itemised` mode) are insert-only. An assignment is **live** while its invoice is not void.
- **Drafting** (`draftInvoice`) locks the encounter, then its standing charges by id, and puts on one draft every charge's unbilled remainder, or the given `portions` (charge id → whole shillings) for a split. A draft has no number. One live `final` per encounter and account; `interim` is refused once a final exists; `supplementary` needs a finalised final.
- **Finalising** (`finaliseInvoice`) freezes `total_cents` from the lines and issues the invoice document in the same transaction. A `final` invoice is refused while any standing charge of the encounter has an unbilled remainder. The printed invoice names who is billed, the patient and OP number, the visit or admission, and each line.
- **Voiding** releases the invoice's charges to be billed again. A draft is discarded by any biller; a finalised invoice is voided only by the finance manager or the facility admin, keeps its number, and voids its document. Slice 5 refuses it while money is allocated to it.
- **Who:** cashiers, billing clerks, the finance manager and the facility admin draft and finalise; those plus claims officers and auditors read. Opening an invoice writes `invoice.viewed`; listing an encounter's invoices writes `encounter.viewed`.
- **Triggers** (every role, the owner included): `invoices_lifecycle` allows draft → finalised, draft → void and finalised → void only, and freezes everything else; `invoice_lines_draft_only` adds lines to drafts only and never changes or removes one; `charge_assignments_within_charge` assigns on drafts only, never a cancelled charge, and never beyond the charge's amount (M4).
- A charge on a live invoice cannot be cancelled; void the invoice first.
- **Payer invoices are not offered over the API in P2.** The cash list prices every charge, and rule 21 forbids billing a payer at cash prices; P7 adds payers' lists. The split is proven by a library test (`src/lib/billing.test.ts`), the dummy-insurer check of `ROADMAP.md` P2.

### 7.4 Payments, allocations, deposits and refunds

| Table | Key columns and rules |
|---|---|
| `payments` | `account_id`, `method` (cash \| mpesa_c2b \| mpesa_stk \| card \| bank \| remittance), `amount_cents`, `reference`, `mpesa_transaction_id`, `cashier_shift_id` (required for counter methods), `encounter_id` (optional: tags a deposit to an admission), `receipt_number`, `received_at`, `reversed_at` + reason |
| `mpesa_transactions` | Raw and append-only, exactly as in school-saas: everything Daraja sends, never edited, guarded by a trigger |
| `allocations` | `payment_id`, `invoice_id`, `account_id`, `amount_cents`, `allocated_by`, `reversed_at` + reason. Ported from school-saas `src/lib/allocations.ts` with `account_id` in the role of `student_id` |
| `refunds` | `payment_id`, `account_id`, `amount_cents`, `method`, `reference`, `number`, `requested_by`, `approved_by` (rule 24), `paid_at`, `reversed_at` |
| `cashier_shifts` | Cashier membership, `opened_at`, `closed_at`, `opening_float_cents`, `declared_cash_cents`. Expected cash and the variance are derived. A counter payment needs an open shift |

- **Recording money and settling bills are two acts**, as in school-saas. A payment lands as credit on its account; allocations decide which invoices it settles, possibly several.
- **A deposit is simply a payment on the patient account** before there is anything to allocate it to. Unallocated credit summed by account is the patient-deposits liability, reported directly because there is no ledger in v1.
- **Refunds are in v1.** If SHA or an insurer covers more than expected, the deposit's unused credit must go back. A refund uses up the payment's unallocated capacity (M2).
- **An invoice's balance** is `total − Σ live allocations − Σ live adjustments`. It is never stored (rule 4), and "paid" is never a status (rule 17).

**As built (P2, slice 5a): shifts, payments, receipts, allocations and deposits.** Decided 2026-11-04: cash and card need an open shift; only finance reverses a payment, never whoever took it; a deposit settles its encounter's bill automatically.

- `cashier_shifts`: the cashier's membership, `opened_at`, `opening_float_cents`, and `closed_at` with `declared_cash_cents` (both or neither). One open shift per cashier (partial unique index). Cash and card taken, cash and card refunded, the expected cash (float plus cash taken, less cash refunded) and the variance are derived. A trigger closes a shift once and freezes the rest, and another refuses a payment or a refund payout through a closed shift, for every role, holding the shift's share lock so a close waits. Opened and closed by the app's clock.
- `payments`: `account_id`, `method` (cash \| card \| bank; slice 6 adds M-Pesa), `amount_cents` (whole shillings), `reference` (required for card and bank, none for cash), `cashier_shift_id` (required exactly for cash and card, by CHECK), `encounter_id` (what it was paid towards), `document_id` (the receipt, `RCT-`), `received_by`, and reversal columns. The shift foreign key is `(facility_id, cashier_shift_id, received_by)`, so a payment's shift is always its receiver's own. A CHECK forbids reversal by the receiver.
- **Taking a payment** issues its receipt in the same transaction. Taken against a bill, as much as the bill owes is allocated at once and the rest stays as credit; the receipt prints what was applied and what is still owed. Taken towards a visit or admission, it is a deposit; but if that encounter's final bill is already out and still owes, it settles that bill like a payment against it.
- **Deposits:** finalising an invoice locks the standing payments tagged to its encounter on the same account (before the invoice, M8) and applies their credit, oldest first, up to the total. Untagged credit is applied on request (`POST /payments/{id}/allocations`, by default as much as both have left).
- `allocations`: `payment_id` and `invoice_id`, each in a three-column FK with `account_id` (M1), `amount_cents`, `allocated_by`, and reversal columns. The service locks the payment, then the invoice, and checks M2 and M3; the `allocations_within_limits` trigger re-checks both for every role, and the adjustment trigger now counts allocations too.
- **Reversing a payment** voids its receipt; its allocations stop being live, so the bills it settled owe again. Reversing an allocation returns its money to the payment's credit. Both are finance's. An invoice with live allocations cannot be voided. A payment with a live refund cannot be reversed (5b).
- **Who:** cashiers, the finance manager and the facility admin take money; billers apply credit; those who read receipts read payments and accounts. `GET /patients/{id}/account` (credit and what each bill owes) writes `account.viewed`.
- A CHECK passes when it evaluates to NULL, so every branch of a CHECK says IS NULL or IS NOT NULL outright: `length(btrim(reference)) > 0` and `decided_by = requested_by` are both NULL on a NULL column. Fixed in 5b for `payments_reference`, and in review for the withdrawn branch of the price-change, adjustment and refund decision checks, a payout's method, and a closed shift's declared cash.

**As built (P2, slice 5b): refunds.** Decided 2026-11-06: billers ask, the finance manager or the facility admin approves, never the asker; payout by cash, card, bank, or M-Pesa sent by hand with its transaction code (no B2C in v1); each refund returns credit from one payment.

- `refunds`: `payment_id` and `account_id` (three-column FK to the payment, M1), `amount_cents` (whole shillings), a one-line `reason`, `status` (pending \| approved \| rejected \| withdrawn), `requested_by`/`requested_at`, `decided_by`/`decided_at` (CHECK: the decider is not the requester, rule 24; only the requester withdraws). Payout columns, all or none and only once approved: `paid_at`, `paid_by`, `method` (cash \| card \| bank \| mpesa), `reference` (none for cash, required otherwise), `cashier_shift_id` (exactly for cash and card; FK `(facility_id, cashier_shift_id, paid_by)`, so it is the payer's own shift), `document_id`. Reversal columns, all or none, only once approved, never by whoever paid it out. "Paid out" is `paid_at`, not a status (rule 17).
- **Asking** names a payment; the amount defaults to all it has left. A request holds nothing.
- **Approving** locks the payment, then the refund (M8), and checks that live allocations and live refunds stay within the payment (M2). From approval until it is reversed, the refund holds its share: credit it holds is not applied to bills, and the payment cannot be reversed.
- **Paying out** is a cashier's (cashier, finance manager, facility admin): cash and card need the payer's open shift, held with a share lock. The refund takes its number then (`RFD-`, yearly, six digits, a fiscal document) and prints who was paid, the receipt it returns, the reason, the method and the amount. Cash paid out lowers the shift's expected cash.
- **Reversing** is finance's: it cancels an approval not yet paid out, or corrects a payout recorded in error (voiding its document, and its cash returns to the shift's expected cash). Either way the amount returns to the payment's credit.
- **Trigger** `refunds_lifecycle` (every role, the owner included): written pending; what was asked never changes; decided once; approval locks the payment and checks M2; paid out once; reversed once; a rejected, withdrawn or reversed refund never changes. `allocations_within_limits` now counts live refunds in M2, and `payments_reverse_only` refuses to reverse a payment with a live refund.
- `GET /refunds?status=` (at most 100, newest first) writes `refund.listed`; `?toPay=true` is the cashier's queue (approved, not paid out, not reversed). A refund, like a credit note, returns its `documentId` for printing. A payment's detail lists its refunds.

**As built (P2, slice 6): M-Pesa paybill (C2B) and STK push.** Decided 2026-11-06: the facility admin sets up the paybill; what a payer types as the account number means an invoice number (settles that bill), an admission number (a deposit for that stay) or a patient's OP or IP number (credit on their account).

- `mpesa_settings` (one row per facility): `shortcode`, `credentials` (consumer key, secret and STK passkey as one value encrypted with AES-256-GCM under `CREDENTIALS_ENCRYPTION_KEY`, never returned), `callback_token` (256 random bits), `urls_registered_at`. Saving queues `mpesa.register_urls` on the outbox (rule 18); the job marks the URLs registered only if the settings are still the ones it sent.
- **Callbacks** (`/webhooks/mpesa/{token}/…`) carry no session: the token is the whole look-up, on the owner connection (`lib/mpesa-callbacks.ts`, allowlisted), and everything after runs as that facility. The shortcode in a payload decides nothing; money for another paybill (the old one while a change settles) is never matched by itself but waits in the queue for a person. Validation always accepts, needs no body, so our outage never fails a payment at the till. A callback we cannot read is kept in `gateway_exchanges` (`c2b_confirmation` or `stk_callback`) and acknowledged.
- `mpesa_transactions`: what Safaricom said, exactly (`source` c2b \| stk, receipt number unique per facility, reference, phone as E.164 when sent whole, payer name, amount, time, raw payload). A trigger freezes everything but `status` (unmatched \| allocated \| rejected, with a reason) and refuses deletion. A confirmation is stored in one transaction and matched in another, so a failure to match never loses the record; a repeat finds the receipt number on file and is acknowledged.
- **Matching** normalises both sides (case, spaces and separators) and applies only an unambiguous match against a patient's bill, an admission, or an OP or IP number. All three are looked up, so a number that names records in two of them (a bill number that is also someone's patient number, once normalised) waits for a person. A payer's bill is never matched. A target that can no longer take the money (a bill voided since) leaves it as credit on the patient's account. Anything else waits in `GET /mpesa/transactions?status=unmatched` (audited `mpesa.listed`: it shows payers' names and phones), where a biller places it (`assign`) or finance sets it aside (`reject`).
- **Payments** gain `mpesa_c2b` and `mpesa_stk`, with `mpesa_transaction_id` (required exactly for those, by CHECK; one live payment per transaction, by partial unique index), the receipt number as `reference`, and no shift. `received_by` (and an allocation's `allocated_by`) is null only for M-Pesa the system matched by itself. Reversing an M-Pesa payment returns its transaction to the queue.
- `mpesa_stk_requests`: a cashier prompts a phone (E.164, Kenyan mobile) for an amount towards a bill, a visit or neither; `queued`, then `sending` (committed before Safaricom is called), then `sent` with Safaricom's checkout id (required: a response without one fails the prompt), then `completed` (naming the transaction) or `failed`. The outbox sends it **once**: Daraja has no idempotency key, so a job that finds a prompt `sending` (a worker died mid-call) closes it instead of prompting again. A paid callback records the payment, received by the cashier who asked; one paid in a different amount, or for a prompt not on record, lands in the queue for a person. A callback that arrives before the checkout id is recorded is applied to its prompt once it is. If the paybill confirmation of the same payment arrives first, the callback recognises its receipt number: still unplaced, it is placed against the prompt; already placed by its reference (an admission or patient number), the prompt is completed with that one payment, which may be patient credit where the prompt was for an outpatient visit, and has no cashier as receiver. Polling shows whether the payment was later reversed. The account reference shown on the phone is the bill, admission or patient number with separators dropped, its last 12 characters (Daraja's limit). A trigger freezes what was asked and a completed prompt.
- `gateway_exchanges`: every Daraja call and STK callback, request (without secrets or the STK password) and response, append-only (rule 18). An `stk_*` exchange names its prompt by foreign key, not a polymorphic id (rule 22).
- **Not yet:** asking Safaricom about a prompt that never called back (it stays `sent`; the money, if taken, still arrives); B2C refunds (refunds are paid out by hand, 5b).

### 7.5 Adjustments: credit notes, waivers, write-offs, disallowances

`invoice_adjustments`: `invoice_id`, `account_id`, `kind` (credit_note \| waiver \| write_off \| payer_disallowance), `amount_cents`, `number` (credit notes are fiscal documents), `reason_code`, `disposition` (rebill \| absorb; set on payer disallowances only, `CHECK ((kind = 'payer_disallowance') = (disposition IS NOT NULL))`), `requested_by`, `approved_by` with `CHECK (approved_by <> requested_by)` (rule 24), `reversed_at` + reason.

Adjustments **share an invoice's capacity with allocations** (M3). An invoice cannot be both paid in full and credited.

**A rejected or reduced claim moves money by document, never by re-opening charges:**

1. Adjudication records `approved_cents` on the claim (§9).
2. A `payer_disallowance` adjustment for the difference is raised on the payer's invoice.
3. The facility's policy for that reason code (`SPEC.md` D4) sets the disallowance's **disposition** when it is raised, and a second person approves it. By default, facility-caused reasons are absorbed (what D4 calls a write-off) and patient-caused reasons are rebilled.
   - **`rebill`:** a **supplementary invoice** to the patient (or a secondary payer), whose `rebill` lines point at the disallowance. Σ rebilled ≤ the disallowance (M5).
   - **`absorb`:** nothing further is billed, and no rebill line may point at it. The disallowance itself is the facility's loss.

**One deduction per amount.** The disallowance already removed the amount from the payer's invoice. Absorbing it raises **no** second adjustment there: a `write_off` on the same invoice would deduct the amount twice, and M3 refuses it, because allocations plus the disallowance already equal the total. The `write_off` kind is for a different case: a patient-account invoice (including a supplementary one) that the facility stops pursuing, i.e. bad debt. Each amount is therefore deducted once, on exactly one invoice.

**Reversing an adjustment** changes only its reversal columns, needs a second person's approval like the original, and returns the amount to the invoice's balance. A disallowance cannot be reversed while a live rebill line points at it; credit the supplementary invoice first.

**As built (P2, slice 4b): credit notes, waivers and write-offs.**

- `invoice_adjustments`: `invoice_id` and `account_id` (three-column FK to the invoice, M1), `kind` (credit_note \| waiver \| write_off; P7 adds `payer_disallowance` and `disposition`), `amount_cents` (whole shillings), a one-line `reason`, `status` (pending \| approved \| rejected \| withdrawn), `requested_by`/`requested_at`, `decided_by`/`decided_at`, and `document_id` for an approved credit note. P2 has no reason codes; a code list waits for the pilot's answer on waivers (`SPEC.md` §9, question 8) and P7's disallowance policy (D4).
- **Who (decided 2026-11-04):** billers (cashier, billing clerk, finance manager, facility admin) ask; the finance manager or the facility admin approves or rejects; only the requester withdraws. A CHECK requires the decider to differ from the requester (rule 24).
- **Only against a finalised invoice, and within what is left (M3).** Approving locks the invoice, then the adjustment, and re-checks that approved adjustments stay within the total. The invoice's balance is its total less approved adjustments (slice 5 subtracts allocations).
- **A credit note takes its number when approved** (`CN-2026-000001`), and its printed document names the invoice it credits, the reason and the amount. Waivers and write-offs are not printed.
- An invoice with an approved adjustment cannot be voided.
- **Trigger** `invoice_adjustments_lifecycle` (every role, the owner included): written pending; decided once; what it asks for never changes; never removed; approval locks the invoice and refuses one that is not finalised or that would take off more than the total.
- **Reversing an approved adjustment** (P2, slice 7a; included in P2 by decision 2026-11-06): a biller asks (`POST /adjustments/{id}/reversals`, with a reason), and the finance manager or the facility admin approves or rejects, never the asker; only the asker withdraws. `adjustment_reversals` holds each request (pending \| approved \| rejected \| withdrawn, CHECK on the decider, at most one open per adjustment by partial unique index). Approving locks the adjustment, then the request, and sets the adjustment's `reversed_at`, `reversed_by` and `reversal_reason`, once (CHECK: only on an approved adjustment, all or none; the trigger requires an approved request decided by the same person, and voids a credit note's document if the writer did not). The adjustment then counts for nothing: its amount owes again, M3 in both triggers and the service skips it, and the invoice may be voided if nothing else stands on it. A credit note's document is voided and keeps its number. `GET /adjustment-reversals?status=pending` is the approver's queue, audited.

Resubmitting a claim does **not** raise a credit note. It creates a new claim version (§9), and money moves only at final adjudication.

### 7.6 Invariants

The cross-row invariants live in `lib/billing.ts` and `lib/allocations.ts`, the only writers of their tables. They run inside the caller's transaction under row locks and are tested under races, in the style of school-saas's `allocations.test.ts`.

| | Invariant | Enforced by |
|---|---|---|
| **M1** | Every money row belongs to one account, and rows that reference each other share it | Three-column composite FKs |
| **M2** | Σ live allocations + Σ live refunds ≤ the payment's amount | Service, payment locked; triggers on allocations and refunds re-check it |
| **M3** | Σ live allocations + Σ live adjustments ≤ the invoice's total | Service, invoices locked |
| **M4** | Σ live assignments ≤ the charge's amount; no final bill while a live charge is not fully assigned | Service, charges locked; a trigger re-checks the first half on every assignment |
| **M5** | Σ rebilled from a disallowance ≤ the disallowance, and zero if its disposition is `absorb`; a disallowance with live rebill lines cannot be reversed | Service |
| **M6** | A remittance is one payment on the payer's account; its lines become allocations plus disallowance adjustments in one transaction; an unexplained shortfall stays open | Service, one transaction |
| **M7** | Σ charges = Σ invoiced + derived allowances + waivers; Σ payments = Σ allocations + Σ refunds + unallocated credit | Reconciliation tests and a daily check |
| **M8** | Lock order: encounter → charges (by id) → payment → invoices (by id); a payment's refund after the payment | Documented once, followed everywhere (rule 23) |

**As built (P2, slice 7b): the reconciliation check.** `reconcile()` (`src/lib/reconciliation.ts`) runs inside one facility's tenant transaction and returns its totals (charged, invoiced, adjusted, received, allocated, refunded, credit, owed) and every drift: M2 (a payment over-applied), M3 (an invoice over-settled), M4 (a charge over-assigned), the second half of M4 (a live charge not fully billed once its encounter's final bill is out) and M-Pesa (a placed transaction without exactly one live payment of its amount, or one not placed with a payment). With no drift, M7 holds by construction: received = allocated + refunded + credit, and invoiced = allocated + adjusted + owed. The daily job (`POST /internal/jobs/reconciliation`, Cloud Scheduler) runs it for every facility; each finding is a `job_failures` row (`job = 'reconciliation'`, ids and amounts only) until a later run no longer finds it, and is logged as `money identities drifted` for alerting. The P2 exit's six-day admission (`src/lib/reconciliation.test.ts`) ends with no drift and these identities checked against the account view.

"Live" means the row is not reversed **and** neither is the payment behind it. That is derived from the `reversed_at` columns, never copied, exactly as in school-saas.

---

## 8. Clinical, inpatient, lab and stores

Designed to the level of key rules. Detailed sketches come with their phase (`ROADMAP.md`).

**Encounters.** `encounters` has `kind` (opd \| ipd \| emergency), a lifecycle status, `started_at` / `ended_at`, the department, and the attending membership. `parent_encounter_id` links a casualty encounter to the admission it led to; whether casualty charges roll into the inpatient bill is a pilot question. `queue_entries` tracks a patient through service points (triage → consultation → lab → pharmacy → cashier). `appointments` drive reminders (`CLAUDE.md` §7).

**As built (P2, slice 2).** A thin version of the above, enough to bill:

- `encounters`: `kind` (opd \| emergency \| ipd), `status` (open \| closed \| cancelled, lifecycle only), `started_at`, `ended_at`, `opened_by` and `closed_by` (memberships), `cancel_reason`, `parent_encounter_id`. A CHECK ties the columns to the status. A partial unique index allows **one open encounter of each kind per patient**. Departments and the attending clinician arrive with P3's queues.
- `admissions`: 1:1 with an ipd encounter; `admission_number` from a new yearly series `admission` (`ADM-2026-0001`, registered at onboarding and backfilled for existing facilities); `discharge_disposition` (home \| referred \| died \| absconded \| against_advice) for MOH 717. The **IP number** is issued at the patient's first admission and reused for every later one.
- `wards`, `beds`: created by the facility admin, renamed or retired, never removed. Occupancy is derived from open stays.
- `bed_stays`: `started_at`, `ended_at`, and a generated `during` tstzrange carrying the two exclusion constraints (no bed holds two patients at once; no admission is in two beds at once), with `btree_gist`. A transfer ends one stay and starts the next at the same instant; discharge or cancellation ends the last. A trigger refuses any change to a stay that has ended.
- Reading an encounter, or a patient's list of encounters, is audited as `encounter.viewed`.
- Roles: visits are opened and closed by records clerks, nurses, doctors, clinical officers and the facility admin; ward nurses can also admit, transfer and discharge. Every member may read.

**As built (P3, slice 1a): practitioners.** Rule 25, decided 2026-11-10 (`ROADMAP.md` P3):

- `memberships` and `invitations` gain `licence_profession`, `licence_number` (stored uppercase, without spaces or dots) and `licence_expires_on` (the last Kenyan day it is valid). This replaces the "cadre, licence body" columns sketched in §3.
- **One licence per member, in their own profession; their roles may span professions.** A nurse who also dispenses at night holds `nurse` and `pharm_tech` under her nursing licence. The council follows from the profession (`src/lib/professions.ts`):

  | Profession | Its roles | Council |
  |---|---|---|
  | `medical_practitioner` | `doctor` | KMPDC |
  | `clinical_officer` | `clinical_officer` | COC |
  | `nurse` | `nurse`, `ward_nurse` | NCK |
  | `laboratory` | `lab_tech`, `lab_supervisor` | KMLTTB |
  | `pharmacy` | `pharmacist`, `pharm_tech` | PPB |

- **The profession is derived when it can be:** a request may leave it out when the clinical roles belong to one profession, and must give it when they span several.
- **The licence must be in the profession of a role held** (`*_licence_fits_roles`, and the service). A licence covers another profession's roles only alongside one of its own, never instead of it: a nurse made a doctor needs a doctor's licence, and a changed set of roles keeps the licence on record only while it still fits.
- **CHECKs on both tables:**
  - a licence is present exactly when a clinical role is held, with its profession, number and expiry always together (`*_licence_iff_clinical`);
  - the profession is a known one (`*_licence_profession_known`);
  - the number has the normalised shape (`*_licence_number_shape`).
- **Inviting:**
  - a clinical role needs the licence, and any other role refuses one;
  - a licence already lapsed is refused;
  - the membership takes the licence on acceptance;
  - an active membership keeps its licence unless the invitation brings one, and a former member comes back with exactly what the invitation offers.
- `GET /staff/members` (facility admin) lists active members, each with their licence, its council and a derived state: `valid`, `expiring` within 30 days, or `expired`.
- `PUT /staff/members/{id}/licence` records a renewal (the profession is kept unless given), audited as `membership.licence_changed` with the old and new values.
- **`PUT /staff/members/{id}/roles`** (facility admin) replaces a member's roles, audited as `membership.roles_changed` with the old and new roles and licence:
  - gaining a clinical role needs a licence unless one is on record, and losing every clinical role clears it;
  - the facility's last admin cannot lose the admin role. Every active admin membership is locked, by id, before the count, so two admins demoting each other at once queue and the second is refused (tested).
- **`requireClinicalRole(...)`** guards clinical routes from slice 2 on: one of the named clinical roles, and a licence valid on today's Kenyan date (valid through its last day). Otherwise it answers 403, code `licence_expired`, saying when the licence lapsed and that the facility admin can record the current one.
- **Rows from before licences:** migration 0040 adds the two `*_licence_iff_clinical` CHECKs `NOT VALID`.
  - They hold for every row written or changed from then on, and an older clinical membership stays as it was.
  - That member cannot act clinically until the admin records a licence, which makes the row valid.
  - A pending clinical invitation without a licence is revoked by the migration, with an audit entry, to be sent again with it.
  - Once no such row is left, `VALIDATE CONSTRAINT` makes both CHECKs whole.
  - This was checked against a database migrated from 0039 with such rows.
- **Not yet:**
  - ending a membership;
  - a check against the health worker registry (AfyaConnect);
  - whether a nurse's pharmacy role may also dispense controlled drugs, which P4 decides with the register (rule 12).

**As built (P3, slice 1b): service points and queues.** Decided 2026-11-10 (`ROADMAP.md` P3):

- `service_points`: a facility's triage desks and clinics. `kind` is `triage` or `consultation`; the name is unique per facility. Set up by the facility admin, renamed or retired, never removed. One with patients still in its queue cannot be retired.
- **Only triage and consultation have queues.** The lab, pharmacy and cashier lists will be derived from the work waiting for them (orders not done, charges not paid), so no queue rows are kept for them.
- `queue_entries`: one patient's turn at one point during a visit.
  - Lifecycle: `waiting` → `serving` → `done`, or `waiting` → `left` (went unseen) or `cancelled` (sent in error).
  - Columns: `joined_at`/`joined_by`; `serving_at`/`served_by` (who called the patient in); `ended_at`/`ended_by` (null when the nightly run ended it). A CHECK ties them to the status.
  - **One queue at a time:** a partial unique index allows one live (`waiting` or `serving`) entry per encounter. Moving on is finishing here and joining the next, in one step.
- **The trigger `queue_entries_lifecycle`** holds the lifecycle for every role, the owner included:
  - an entry is inserted `waiting`, into an open `opd` or `emergency` encounter, at a service point in use;
  - it moves only along the lifecycle above;
  - its visit, point and joining never change, nor does who served the patient;
  - an ended entry never changes, and no entry is deleted.
- **Opening a visit joins a queue in the same step:**
  - `queueAt` names the point, and `null` joins none (a walk-in for the lab);
  - left out, the patient joins the facility's triage point when it has exactly one.
- **Who:**
  - the queue staff (records clerks, nurses, ward nurses, doctors, clinical officers, the facility admin) view queues, send patients to one, and take a waiting patient out;
  - calling a patient in and finishing with them is a clinical act: a doctor, clinical officer, nurse or ward nurse with a current licence (`requireClinicalRole`).
- **Locks:** every change locks the encounter first, then the entry (M8), so two clinicians calling the same patient queue and the second is refused (tested), and a visit cannot close while its patient is being queued.
- **Ending a visit:**
  - closing a visit is refused while its patient is in a queue (`still_queued`), so nobody waits for a call that cannot come;
  - cancelling a visit opened in error cancels its waiting entry, and is refused while a clinician is seeing the patient (`being_seen`): they finish with the patient first.
- **The attending clinician is derived, not stored:** whoever most recently called the patient in at a consultation point. The encounter's detail shows it, with the queue the patient is in now.
- **Reading a queue** (`GET /service-points/{id}/queue`) lists those being seen, then those waiting by arrival, each with name, OP number, sex and age. It is audited as `queue.viewed`, since it names patients and where they are.
- **The nightly close** (`POST /internal/jobs/close-visits`, `src/jobs/visits.ts`):
  - closes every `opd` visit opened before that Kenyan day and still open, with `closed_by` null (the `encounters_lifecycle` CHECK now allows that for a closed visit) and an audit entry with no actor;
  - a waiting patient's entry becomes `left`, and one still being seen becomes `done`;
  - emergency attendances and admissions are left alone, since they may run overnight;
  - each visit is closed at the time the run locks it, not when the run began, so a patient called in meanwhile is never ended before being seen;
  - each visit is closed in its own transaction, so one that cannot be closed leaves the rest closed. It becomes a `job_failures` row (`visit_close`) naming the visit; a facility whose visits cannot even be listed becomes one with no subject. A later run for that facility with no failure resolves the failures recorded before it began, but not one an overlapping run recorded since.
- **Not yet:**
  - a visit closing itself once nothing is pending, which needs orders (4a);
  - a triage priority ordering the consultation queue (slice 2).

**As built (P3, slice 1c): consultation fees and paying.** Decided 2026-11-10 (`ROADMAP.md` P3, `SPEC.md` §2):

- **A clinic's fee:** `service_points.consultation_item_id` names the billable item that a consultation at that clinic is charged as.
  - The facility admin sets it, to an active `consultation` item. A CHECK keeps it off triage points.
  - Its price comes from the cash list on the day, as a ward's bed-day does. A change applies to patients who join from then on.
- **Charged as the patient joins the clinic's queue**, so a patient paying as they go can pay before they are seen (rule 16: the clinic's work raises it). The charge's source is its queue entry: `charges.queue_entry_id`, a typed source alongside `bed_stay_id`.
  - **Once per visit per clinic:** a patient sent back with results is not charged again unless the earlier fee was cancelled, and a referral to another clinic with a fee is charged there. The service checks this under the encounter's lock; `charges_one_per_queue_entry` allows one fee per turn.
  - **A fee with no price refuses the join** (`fee_unpriced`), and the request writes nothing, so the setup is fixed rather than the fee lost (rule 21).
- **Leaving unseen cancels the fee while it is unbilled.** That covers taken out of the queue as left or sent in error, the visit cancelled as opened in error, or the nightly close finding the patient still waiting. A fee already billed stands, and is credited or refunded like any billed charge.
  - The nightly run cancels with `cancelled_by` null. The `charges_cancellation_complete` CHECK now allows that only for a fee, a charge with a queue entry.
  - `charges_cancel_only` freezes `queue_entry_id` with the other columns.
- **Paying, both ways and with no setting:**
  - `POST /encounters/{id}/bill-now` bills every charge not yet billed, drafted and finalised in one step. It is an interim invoice before the final one, and a supplementary one after it.
  - A patient billed at the end gets the final invoice as in P2.
  - Credit paid towards the visit is applied as the invoice is finalised, as in P2.
- **The cashier's list** (`GET /cashier/due`, billers) shows every open outpatient visit or emergency attendance with money due, oldest first, 200 at a time (`offset` for the next page).
  - What is due is the charges no live invoice asks for, what its patient bills still in draft ask for (`draftedCents`: a draft left unfinalised keeps the visit listed), and what its finalised patient bills still owe.
  - It is derived (rule 4) and audited as `billing.due_listed`.
  - Admissions keep their own running bill and are not listed.
- **Not yet:** the lab's warning on a test not yet paid for (5a).

**As built (P3, slice 2): triage, vital signs and allergies.** Decided 2026-11-10 (`ROADMAP.md` P3):

- **Vital signs** (`observations`): temperature, pulse, respiratory rate, systolic and diastolic blood pressure, SpO2, weight, height, MUAC, blood glucose and pain score.
  - Each sign has one unit, from `src/lib/vital-signs.ts`.
  - A set taken together shares its `observed_at`, which falls within the encounter and never in the future.
  - Blood pressure needs both readings.
- **Ranges catch typing slips, not illness.** A value outside what a real reading can be is refused by the route and by the `observations_value_plausible` CHECK, which is built from the same list. A value inside it is stored however abnormal.
  - Normal-range flags are not built: they depend on age and are still to confirm. NEWS2 belongs to the ward observation charts (P5, decided 2026-11-10).
  - Codes are this system's own. Mapping to LOINC waits for DHA's vital-sign profiles.
- **A wrong reading is marked entered in error**, with a reason, and stays on the record. The trigger `observations_error_only` refuses any other change, and any deletion, for every role.
- **A visit with readings still standing cannot be cancelled** as opened in error (`has_clinical_records`), whether or not its queue entry is finished. Once every reading is marked entered in error (the wrong patient's record), it can be.
- **Allergies** (`patient_allergies`, per patient rather than per visit): `category` (drug, food, environment, other), `allergen` as told, optional `reaction` and `severity`.
  - **"No known allergies"** is its own row (`none_known`), at most one standing per patient (partial unique index), since "asked, and none" differs from "never asked". An empty list means nobody has asked.
  - Recording an allergy ends a standing "no known allergies"; "no known allergies" is refused while an allergy stands.
  - An allergy is ended as entered in error or no longer applying, never edited or deleted (trigger `patient_allergies_end_only`).
  - Changes for one patient lock the patient's row.
  - Drug allergies are free text until slice 4b links them to the drug catalogue for prescribing checks.
- **The triage priority** (`queue_entries.priority`: emergency, urgent, routine) is set as triage finishes with the patient.
  - The CHECK `queue_entries_priority_when_done` holds it to a finished entry, and the queue trigger to a triage point.
  - **Clinic queues order by it:** emergency, urgent, then routine or untriaged, each by arrival.
  - The priority is the visit's latest triage entry's, derived per row and not copied, so a patient sent back to a clinic keeps it.
- **Who:**
  - recording vital signs is a clinical act for doctors, clinical officers, nurses and ward nurses, under a current licence;
  - pharmacists and pharmacy technicians may also record and remove allergies;
  - only clinical roles read either, as decided (2026-11-10). Each read is audited, as `encounter.viewed` and `patient.viewed`.

**As built (P3, slice 3a): diagnoses in ICD-11.** Decided 2026-11-10 (`SPEC.md` §4, question 8):

- **`icd_codes`**, the first shared reference table (CLAUDE.md rule 1): no `facility_id`, no row-level security, and `SELECT` only for the app role.
  - It holds the categories of ICD-11 MMS chapters 01–25: `code`, `title`, `uri` (the linearization URI, which residual codes have even without a foundation URI), `chapter`, `is_leaf`, `is_residual`, `release`, `retired_at`.
  - Extension codes (chapter X) qualify other codes and are never a diagnosis alone. The supplementary chapters (V, 26) are not loaded either.
  - The 2026-01 release gives 17,255 codes, 14,793 of them leaves.
- **Loaded per environment by `pnpm icd11:load <file>`** (`src/lib/icd11-load.ts`, on the owner connection), from the `.txt` in WHO's release zip, unmodified.
  - The release is read from the file's `Version:` column, and a release older than one already loaded is refused.
  - A file cut short is refused: WHO prints chapter X last, so a file that never reaches it lost its end, and loading it would retire every code it lost. So is a leaf or residual flag other than `True` or `False`.
  - So is a release that would retire more than 5% of the codes in use (at least 100 may always go). WHO's releases retire a few dozen: 2026-01 retired 22 of 2025-01's 17,231 codes. More means codes are missing from the file.
  - The release image has no `tsx`, so there it runs as `node ./dist/src/cli/load-icd11.js` (`docs/deployment.md` §3).
  - One transaction; a code a newer release no longer has is marked retired, never deleted.
- **WHO's licence** (CC BY-ND 3.0 IGO, icd.who.int) allows storing the classification in software provided each code keeps its title and URI, and the classification is not altered. So:
  - titles are kept as WHO wrote them (only the file's "- " depth markers are dropped);
  - `is_residual` and `retired_at` are this system's own fields;
  - a diagnosis copies all three of code, title and URI.
  - Mapping ICD-11 to another classification needs WHO's written agreement, which matters for the MOH 705 report in P6 (`ROADMAP.md` P3, still open).
- **Search** (`GET /icd-codes?q=`, clinical roles, not audited since it involves no patient data):
  - each word typed matches the start of a word in the title, or the text matches the start of a code (exact code first);
  - only leaves still in the current release, at most 20;
  - a GIN index on `to_tsvector('simple', title)`, the very expression the query uses.
  - WHO's synonym index is in its online API only, so titles are what is searched for now.
- **`diagnoses`**, on an encounter:
  - the code (foreign key to `icd_codes`) with its title, URI and release copied as diagnosed (rule 7), so a later release never changes the record;
  - `certainty` (provisional or confirmed) and `rank` (principal or secondary), with at most one standing principal per encounter (partial unique index). The first diagnosis is the principal; a later one is secondary unless made principal, which demotes the other.
  - Recorded only on an open encounter, and only under a leaf code still in the current release; the same code twice is refused.
  - **Confirmed once**, also after the visit has closed (a result arrives the next day), recording when and by whom. **Ended once**, as ruled out or entered in error; an ended diagnosis stays on the record and never changes.
  - Every change locks the encounter first (M8).
  - The trigger `diagnoses_lifecycle` holds the lifecycle for every role: written standing, what was diagnosed never changing, confirmed once with when and by whom, ranked only while standing, ended once, never deleted.
  - Which encounter and code a diagnosis may be recorded on (an open visit, a current leaf, not twice) is the service's check, under the encounter's lock, not the trigger's. A hand-run import of a hospital's past records must be able to bring in closed visits and codes since retired.
- **Who:**
  - doctors, clinical officers and nurses (in nurse-led clinics) diagnose, under a current licence;
  - clinical roles read diagnoses, audited as `encounter.viewed`.
- **Cancelling a visit** is refused while a diagnosis stands (`has_clinical_records`), as for vital signs.
- **Not yet:** postcoordinated (cluster) codes, and marking sensitive codes for break-glass (slice 7).

**As built (P3, slice 3b): clinical notes.** Decided 2026-11-10 (`ROADMAP.md` P3):

- **`clinical_notes`, three kinds:**
  - a **consultation** note, in the sections of an outpatient card: presenting complaint, history, examination, plan (at least one);
  - a **nursing** note: text;
  - an **addendum** to a signed note: text, with `addendum_of`.
  - `clinical_notes_shape` holds each kind to its content.
- **Draft, then signed** (`status`: draft, signed, discarded, lifecycle only):
  - the author drafts and saves (each save replaces the draft's content), then signs, which freezes the note (rule 19);
  - a draft is the author's alone: anyone else is answered as if it did not exist, and it is not listed for them;
  - a draft may be discarded, which keeps it on the record, unshown, and never deletes it;
  - a draft is started only on an open encounter, and may be signed after the visit closes, for notes finished the next morning.
- **Corrections are addenda**, written signed by any note-writing clinician and shown under the note. An addendum is never added to another addendum.
- **The author saves and signs a draft only while still holding a role that writes its kind** (a nurse moved to the wards no longer signs a consultation note). Discarding needs neither a clinical role nor a current licence, since it is not a clinical act: an author whose licence lapsed, or whose roles changed, can still clear a draft that would keep a visit from being cancelled. Any note that is not one of the actor's own drafts is answered as not found. A facility admin discarding someone else's draft waits for memberships that can end.
- **A signed note written on the wrong patient's record is marked entered in error**, with a reason, and stays on the record; it then takes no addendum. An addendum may be marked too (one added to the wrong patient's note), and is shown marked under its note.
- **The trigger `clinical_notes_lifecycle`** holds all of this for every role:
  - drafts are written as drafts, and addenda signed, to a signed note on the same encounter that is neither an addendum nor marked entered in error (locked while checked);
  - whose note it is, its kind and its encounter never change;
  - a signed note changes only by being marked entered in error, once;
  - a discarded draft never changes, and nothing is deleted.
- **Who:**
  - consultation notes: doctors, clinical officers and nurses (nurse-led clinics);
  - nursing notes: nurses and ward nurses;
  - all under a current licence (`requireClinicalRole`, then `NOTE_WRITERS` per kind).
  - Clinical roles read signed notes, audited as `encounter.viewed`. Each write is audited without the note's text, which stays in this table only (rule 10).
- **Cancelling a visit** is refused while a draft, or a signed note or addendum not marked entered in error, stands (`has_clinical_records`), as for vital signs and diagnoses. An addendum counts even under a marked note: once the visit is cancelled it could no longer be marked.
- **Not yet:** sensitive notes and break-glass (slice 7); note templates by clinic, which the frontend can offer over these sections.

**Clinical record.** `observations` (vitals and charted values, with `entered_in_error` instead of deletion), `diagnoses` (ICD code, provisional \| final \| secondary), `clinical_notes` (`signed_at`, `addendum_of`: a signed note is corrected only by an addendum), `orders` and `order_items` (lab, imaging, procedure, medication, service; medication items carry dose, route, frequency and duration). Every clinical act records the acting membership, whose licence details live on `memberships` (rule 25).

**Inpatient.** `admissions` is 1:1 with an ipd encounter and carries the admission number. `bed_stays` holds a `tstzrange` with two `EXCLUDE` constraints: no bed holds two patients at once, and no admission is in two beds at once. A transfer ends one stay and starts the next. `medication_administrations` records each dose against its order item (given \| held \| refused \| missed). `discharge_summaries` are immutable once signed.

**Lab.** `lab_tests` is the facility's catalogue (specimen type, reference ranges by sex and age, billable item). `specimens` carry the accession number (§6.1), collection and receipt times, and a rejection reason. `lab_results` are versioned with `supersedes_id`. `verified_by` must differ from the person who entered the result, and a result reaches the clinician only once verified.

**Pharmacy and stores.** `inventory_items` reference the shared `drug_catalogue` (or describe a non-drug consumable) and a billable item. `stores` covers the main store, the pharmacy, wards and other sub-stores. `stock_batches` hold batch number, expiry and cost. `stock_movements` are append-only signed quantities (opening balance, receipt, dispense, transfer out/in, adjustment, write-off, return) with typed source FKs. An opening balance loads counted stock at go-live; it is its own kind so it never reads as a purchase. Each item has a reorder level per store, which drives the low-stock alert. **On hand per store and batch = Σ movements, never stored, never negative** (checked under a batch lock). `dispenses` take stock first-expiry-first-out and raise the charge. `controlled_drug_register` is append-only with a running balance per item and store. `goods_received` records the supplier as text in v1, since supplier payables come later. Units of sale are still open (`SPEC.md` §4).

---

## 9. Payers and claims

| Table | Key columns and rules |
|---|---|
| `payer_registry` | Shared reference: SHA and the private insurers, with their codes |
| `payers` | The facility's relationship with a payer: registry entry, contract reference, credit terms. Owns a payer `account` |
| `payer_schemes` | Per payer: name, SHA fund (`phc` \| `shif` \| `eccif`, verify), co-pay rule (basis points or fixed), limits, `price_list_id`, whether top-ups are allowed |
| `patient_coverages` | Patient, scheme, member number, principal or dependant (with the principal's number), valid from/to |
| `encounter_coverages` | The encounter's **billing plan**: which coverages apply, in `priority` order, each with its preauthorization |
| `eligibility_checks` | Append-only log: coverage, encounter, channel, result (eligible \| not_eligible \| unknown), external reference, `gateway_exchange_id` |
| `preauthorizations` | Encounter coverage, requested and approved amounts, approval reference, `valid_until`, lifecycle status |
| `claims` | `invoice_id` (a payer's final or supplementary invoice), `version`, `supersedes_id`, `claimed_cents` (frozen from the invoice), `approved_cents`, payer reference, channel, `status` |
| `claim_items` | Per invoice line: claimed and approved amounts, rejection reason code |
| `gateway_exchanges` | Append-only record of every external call: channel, operation, outcome, timing, and the request and response held in the database (rule 10) |
| `remittances`, `remittance_lines` | A payer's remittance advice: the `payment` it arrived as, and per claim the paid amount, disallowed amount and reason code |

- **Claim status is lifecycle only:** draft \| submitted \| queried \| adjudicated \| withdrawn \| superseded. Approved, partially approved and rejected are derived from `approved_cents` against `claimed_cents`. Paid is derived from allocations (rule 17).
- **A submitted claim is immutable.** A correction is a new version that supersedes the old one (rule 19).
- **External calls go through the outbox** (rule 18). The intent is written and committed, the call is made, and the result is recorded in a new transaction. A slow SHA endpoint must never hold the number-series or allocation locks.
- **`PayerGateway`** is one interface with two implementations planned for v1:
  - `manual`, for **private insurers**: it produces a claim pack, records the officer's submission, and imports remittances from a file or by hand.
  - `afyaconnect`, for **SHA**: eligibility, preauthorization and claims through DHA's integration platform. It is built against the sandbox in P7 and goes live only after DHA certification (`ROADMAP.md` P8). There is no manual SHA channel; SHA's provider portal is closing (`SPEC.md` §8).

  Insurer e-claims (SMART, Slade360) arrive later as further implementations.
- **The SHA → insurer → patient cascade** follows `encounter_coverages.priority`. How much of an absorbed charge a secondary payer or the patient may be billed depends on SHA's top-up and balance-billing rules: verify before P7 (`SPEC.md` §10).
- **PHC capitation** is money not tied to any invoice. Whether it applies at Level 4 is unknown, so it is not modelled. Do not guess (`SPEC.md` §4).

---

## 10. Append-only and immutable data

**Append-only** (enforced by a trigger; the app role holds `INSERT` and `SELECT` only): `audit_log`, `mpesa_transactions`, `gateway_exchanges`, `eligibility_checks`, `stock_movements`, `controlled_drug_register`.

**Immutable once finalised** (a trigger refuses updates to frozen columns; corrections are a credit note, a new version or an addendum):

- issued documents (§6.2): voidable once, never edited or deleted
- finalised invoices and their lines
- submitted claims and their items
- signed clinical notes and discharge summaries
- verified lab results
- dispenses

**Reversal only:** payments, allocations, charges, refunds and invoice adjustments may change only their reversal or cancellation columns. Every other column is frozen from the moment the row is written.

The school SaaS's `mpesa_transactions_immutable()` and `report_cards_snapshot_frozen()` triggers are the pattern.

---

## 11. Open questions

- Confirm the assumptions in §2 (IP number at first admission, padding default, prefix changes, `sex` options, bed-day rule).
- Should a facility be blocked from changing its prefix after patients exist, or is a warning enough?
- Do staff need to look patients up by number without the prefix (e.g. typing `42` for `OP0042`)?
- SHA package structure, top-up rules and fund-level remittances shape §7.2, §7.3 and §9. Verify before P7; the account and charge-assignment structures they depend on are built earlier, in P2.
- Whether any payer requires numbered interim invoices for long admissions.
- Units of sale for pharmacy stock (`SPEC.md` §4, question 2).
