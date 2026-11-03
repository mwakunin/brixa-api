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
- The `sex` option set (currently `male` / `female`) needs confirming.
- The bed-day counting rule (midnight census, 24-hour blocks, or admission day counts) — a pilot question (`SPEC.md` §9).

---

## 3. Entity map

Every table carries `facility_id` except the shared reference group.

| Module | Tables |
|---|---|
| Tenancy and access | `facilities` (kmhfr_code, level, SHA contract ref), `memberships` (roles[], cadre, licence body and number), `departments`, `service_points`, `number_series`, `audit_log`, `outbox`, `job_failures`, `files` |
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

- `number_series` gains `reset_period` (`never` \| `yearly` \| `daily`) and the unique key becomes `(facility_id, kind, period_key)`, where `period_key` is `'all'`, `'2026'` or `'2026-11-03'`, computed in Africa/Nairobi (rule 26). The row for a new period is created on first use with `INSERT … ON CONFLICT DO NOTHING`, then locked as above.
- **Fiscal numbers are issued at finalisation**, in the same transaction that freezes the document, never at draft (rule 20). A draft invoice has no number. A voided document keeps its number, so the sequence has no gaps an auditor must explain.
- The counter lock serializes finalisations per facility and kind. This is acceptable because finalisation is fast and does no external I/O (rule 18). A SHA call must never run while the lock is held.

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

**Bed-days** are derived from `bed_stays` time ranges and turned into charges by one idempotent function. A partial unique index on `(encounter_id, charge_date)` for bed-day charges makes a second run a no-op. The nightly job, the running bill and discharge all call that function, so a missed night is caught up rather than lost.

### 7.3 Invoices: who is asked to pay

| Table | Key columns and rules |
|---|---|
| `invoices` | `account_id`, `encounter_id`, `kind` (interim \| final \| supplementary), `status` (draft \| finalised \| void, lifecycle only, rule 17), `number` (issued at finalisation, §6.1), `total_cents` (frozen from the lines at finalisation), `finalised_at`, `voided_at` + reason. **One live `final` invoice per (encounter, account)** via a partial unique index. |
| `invoice_lines` | `kind` (itemised \| package \| rebill), description and code snapshot, `quantity`, `unit_price_cents`, `amount_cents`. Package lines carry the SHA package/tariff reference. Rebill lines carry `source_adjustment_id` (§7.5). |
| `charge_assignments` | `charge_id`, `invoice_line_id`, `amount_cents`, `mode` (itemised \| absorbed). Splits a charge across accounts: an insurer's 80% and the patient's 20% co-pay are two assignments of one charge. |

- **The running bill** for a long admission is a derived, unnumbered view of charges and their likely split, plus deposit top-up requests. Numbered interim invoices exist only where a payer requires them (pilot question).
- **Package lines absorb charges.** A SHA package line (for example per-diem × days) is linked to the charges it covers through `absorbed` assignments. The contractual allowance (absorbed charges minus the package amount) is **derived, never stored**. Whether the remainder may be billed to a secondary payer or the patient depends on SHA's top-up rules (verify, `SPEC.md` §10).
- An encounter cannot be final-billed while any live charge is not fully assigned (M4).

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

Resubmitting a claim does **not** raise a credit note. It creates a new claim version (§9), and money moves only at final adjudication.

### 7.6 Invariants

The cross-row invariants live in `lib/billing.ts` and `lib/allocations.ts`, the only writers of their tables. They run inside the caller's transaction under row locks and are tested under races, in the style of school-saas's `allocations.test.ts`.

| | Invariant | Enforced by |
|---|---|---|
| **M1** | Every money row belongs to one account, and rows that reference each other share it | Three-column composite FKs |
| **M2** | Σ live allocations + Σ live refunds ≤ the payment's amount | Service, payment locked |
| **M3** | Σ live allocations + Σ live adjustments ≤ the invoice's total | Service, invoices locked |
| **M4** | Σ live assignments ≤ the charge's amount; no final bill while a live charge is not fully assigned | Service, charges locked |
| **M5** | Σ rebilled from a disallowance ≤ the disallowance, and zero if its disposition is `absorb`; a disallowance with live rebill lines cannot be reversed | Service |
| **M6** | A remittance is one payment on the payer's account; its lines become allocations plus disallowance adjustments in one transaction; an unexplained shortfall stays open | Service, one transaction |
| **M7** | Σ charges = Σ invoiced + derived allowances + waivers; Σ payments = Σ allocations + Σ refunds + unallocated credit | Reconciliation tests and a daily check |
| **M8** | Lock order: encounter → charges (by id) → payment → invoices (by id) | Documented once, followed everywhere (rule 23) |

"Live" means the row is not reversed **and** neither is the payment behind it. That is derived from the `reversed_at` columns, never copied, exactly as in school-saas.

---

## 8. Clinical, inpatient, lab and stores

Designed to the level of key rules. Detailed sketches come with their phase (`ROADMAP.md`).

**Encounters.** `encounters` has `kind` (opd \| ipd \| emergency), a lifecycle status, `started_at` / `ended_at`, the department, and the attending membership. `parent_encounter_id` links a casualty encounter to the admission it led to; whether casualty charges roll into the inpatient bill is a pilot question. `queue_entries` tracks a patient through service points (triage → consultation → lab → pharmacy → cashier). `appointments` drive reminders (`CLAUDE.md` §7).

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
