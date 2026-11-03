# Schema Design — Entity Map and Patient Numbering

Status: proposed · Last updated: 2026-09-21

`SPEC.md` is the source of truth for decisions and open questions; `CLAUDE.md` holds the conventions code must follow. This document covers the data model. Only the patient numbering tables are designed in detail so far. Everything else is an entity map.

---

## 1. Decided

- Patient numbers are **auto-generated and sequential**, per clinic.
- Each clinic **chooses its own prefix** per series, e.g. `OP` for outpatient and `IP` for inpatient.
- The **IP number is issued once per patient and linked to their OP number**. It is not issued per admission.

## 2. Assumptions to confirm

- The OP number is issued at registration. The IP number is issued at the patient's first admission. (The inpatient module itself is deferred beyond v1, but the numbering supports it now without schema changes.)
- The zero-padded width is configurable per series, default 4 (`OP0001`).
- A clinic may change its prefix later. The change applies to newly issued numbers only.
- The `sex` option set (currently `male` / `female`) needs confirming.

---

## 3. Entity map (proposed)

| Group | Tables |
|---|---|
| Tenancy and access | `clinics`, `memberships`, `number_series`, `audit_log` |
| Patients | `patients`, `patient_numbers`, `patient_identifiers`, `patient_contacts` (next of kin; guardian for minors) |
| Clinical | `visits`, `queue_entries`, `appointments`, `vitals`, `diagnoses` (ICD-10), `consultation_notes`, `prescriptions`, `prescription_items` |
| Billing | `service_catalogue`, `invoices`, `invoice_lines`, `payments` (a payer on every invoice) |
| Pharmacy | `drug_catalogue`, `inventory_items`, `stock_batches`, `stock_movements`, `controlled_drug_register` |

Not yet designed in detail: everything except the patient numbering tables in section 5.

---

## 4. Conventions that apply (see `CLAUDE.md` section 3)

- `clinic_id` on every tenant table, with RLS policies and composite foreign keys `(clinic_id, id)`. The Drizzle sketches below use simple references for readability; the real tables must use the composite form.
- Text columns typed with `.$type<...>()` carry a matching `CHECK`.
- Nothing hard-deletes. Phone numbers are E.164. Dates are `date`; instants are `timestamp`.
- No patient data in URLs, logs, Redis keys, queue payloads, or object keys.

---

## 5. Tables (Drizzle sketch)

```ts
// One counter per clinic per series. Extending `kind` later (e.g. 'invoice', 'receipt')
// lets the same table issue gap-free sequential numbers for financial documents.
export const numberSeries = pgTable('number_series', {
  id: uuid('id').primaryKey().defaultRandom(),
  clinicId: uuid('clinic_id').notNull().references(() => clinics.id),
  kind: text('kind').$type<'outpatient' | 'inpatient'>().notNull(), // + oneOf CHECK
  prefix: text('prefix').notNull(),                  // 'OP', 'IP'
  padding: integer('padding').default(4).notNull(),  // OP0001; grows past the width, never truncates
  nextValue: integer('next_value').default(1).notNull(),
}, (t) => [unique().on(t.clinicId, t.kind)]);

export const patients = pgTable('patients', {
  id: uuid('id').primaryKey().defaultRandom(),
  clinicId: uuid('clinic_id').notNull().references(() => clinics.id),

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
  index().on(t.clinicId, t.familyName),
  index().on(t.clinicId, t.phone),
]);

// One row per number issued to a patient. The OP row and the IP row share a patient_id,
// which is what "linked with the OP" means.
export const patientNumbers = pgTable('patient_numbers', {
  id: uuid('id').primaryKey().defaultRandom(),
  clinicId: uuid('clinic_id').notNull(),
  patientId: uuid('patient_id').notNull().references(() => patients.id),
  kind: text('kind').$type<'outpatient' | 'inpatient'>().notNull(), // + oneOf CHECK
  number: text('number').notNull(),                  // frozen text, e.g. 'OP0042'
  issuedAt: timestamp('issued_at').defaultNow().notNull(),
}, (t) => [
  unique().on(t.clinicId, t.number),                 // no two patients share a number
  unique().on(t.patientId, t.kind),                  // at most one OP and one IP number per patient
]);

export const patientIdentifiers = pgTable('patient_identifiers', {
  id: uuid('id').primaryKey().defaultRandom(),
  clinicId: uuid('clinic_id').notNull(),
  patientId: uuid('patient_id').notNull().references(() => patients.id),
  type: text('type')
    .$type<'national_id' | 'passport' | 'birth_certificate' | 'sha_number' | 'other'>()
    .notNull(),                                      // + oneOf CHECK
  value: text('value').notNull(),
}, (t) => [index().on(t.clinicId, t.type, t.value)]); // index, not unique: warn on duplicates instead
```

---

## 6. Issuing numbers

Allocate inside the same transaction that creates the patient (OP) or admits them for the first time (IP):

```ts
async function issuePatientNumber(
  tx: Tx, clinicId: string, patientId: string, kind: 'outpatient' | 'inpatient',
) {
  // Idempotent: a patient has at most one number per kind.
  const [existing] = await tx.select().from(patientNumbers)
    .where(and(eq(patientNumbers.patientId, patientId), eq(patientNumbers.kind, kind)))
    .limit(1);
  if (existing) return existing.number;

  const [row] = await tx.update(numberSeries)
    .set({ nextValue: sql`${numberSeries.nextValue} + 1` })
    .where(and(eq(numberSeries.clinicId, clinicId), eq(numberSeries.kind, kind)))
    .returning({
      prefix: numberSeries.prefix,
      padding: numberSeries.padding,
      issued: sql<number>`${numberSeries.nextValue} - 1`,
    });

  const number = `${row.prefix}${String(row.issued).padStart(row.padding, '0')}`;
  await tx.insert(patientNumbers).values({ clinicId, patientId, kind, number });
  return number;
}
```

Rules and reasoning:

- **A counter row, not a Postgres sequence.** The row lock serializes concurrent registrations per clinic and series, which is fine at clinic scale. Because it is in the same transaction as the insert, a failed registration does not burn a number. Native sequences are not transactional (a rollback leaves a gap), and per-clinic sequences would need dynamic DDL.
- **Constraints are the backstop.** `unique(clinic_id, number)` prevents duplicates. `unique(patient_id, kind)` means that if two requests try to issue the same patient's first IP number at once, the second fails and rolls back, taking its counter increment with it. The caller then re-reads the existing number.
- **Issued numbers are frozen text.** Never rebuild a number from the current prefix.
- **Prefix changes apply going forward.** The counter keeps counting, so the numeric part never repeats within a series.
- **Onboarding needs a start value.** A clinic moving from a paper register continues from its current number. Import legacy numbers as-is (free text), and set the counter above the highest legacy number so generated numbers cannot collide.
- **Merging duplicate patients.** Set `merged_into_id` on the duplicate; never delete. The duplicate's numbers keep resolving by following the pointer, and numbers are never reused.
- **Sequential means guessable.** Never put a patient number in a URL or treat it as a secret. URLs use the UUID; the number is for humans and search. Access is protected by RLS, roles, and the audit log (including reads).
- **Register the series at clinic onboarding.** Create the OP series when a clinic is created (and the IP series when the inpatient module is enabled), with the clinic's chosen prefix.

---

## 7. Open questions

- Confirm the assumptions in section 2 (IP number issued at first admission, padding default, prefix changes, `sex` options).
- Should a clinic be blocked from changing its prefix after patients exist, or is a warning enough?
- Do clinics need to look patients up by number without the prefix (e.g. typing `42` for `OP0042`)?
