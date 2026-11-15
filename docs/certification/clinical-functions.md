# Clinical functions

Status as of P3 (2026-11-15): the outpatient department and the laboratory. Inpatient care arrives in P5 and the pharmacy's dispensing in P4, and this page grows with them.

DHA's self-attestation asks a vendor to describe its system's clinical functions (`SPEC.md` §8). The exact questions are still to be obtained (`SPEC.md` §4, question 11). Until then, this page describes each function this system performs, where it is implemented, and the automated test that proves it. Every test named here runs against a real PostgreSQL database on every change, and the build fails if one fails.

**The end-to-end evidence** is `src/routes/opd-journey.test.ts`. It runs a day's outpatients through the API, as the staff application drives it:

- a patient who pays at each step: registration, triage, consultation, a laboratory test, a review with the result, and a printed prescription;
- a patient seen on an appointment, who pays at the end by M-Pesa;
- a walk-in laboratory client referred by an outside doctor.

Every charge comes from the clinical work itself, none is entered by hand, every visit closes once nothing is pending, and the day's money reconciles.

The data model follows the names of HL7 FHIR resources, which DHA's implementation guides use, so that a FHIR interface can be added without remodelling. This version offers no FHIR interface.

## Functions

| Function | What the system does | FHIR resource | Implemented in | Proven by |
|---|---|---|---|---|
| Patient registration | Registers a patient with an outpatient number from the facility's own series. Records several identifiers per patient (national ID, passport, birth certificate, SHA number, client-registry ID), and stores phone numbers in international form. A patient who cannot be identified, such as one brought in unconscious, is registered with the reason, and the record shows what is still to collect. Possible duplicates are flagged before a second record is created. | Patient | `src/lib/patients.ts` | `src/routes/patients.test.ts` |
| Practitioners | Every clinical role carries a practising licence (profession, number, expiry), and the council follows from the profession. Clinical acts are refused once the licence has lapsed, and the facility admin is warned 30 days ahead. Each clinical act records the licensed member who performed it. | Practitioner, PractitionerRole | `src/lib/practitioners.ts`, `src/middlewares/auth.ts` | `src/routes/staff.test.ts` |
| Visits and queues | Opens an outpatient visit or emergency attendance. The patient moves through triage and the clinics one queue at a time. Triage priority (emergency, urgent, routine) orders the clinic queues. The attending clinician is derived from who saw the patient. | Encounter | `src/lib/encounters.ts`, `src/lib/queues.ts` | `src/routes/encounters.test.ts`, `src/routes/queues.test.ts` |
| Appointments | Books a patient at a clinic for a day, with a time and a clinician if wanted. Moves and cancels bookings, and checks the patient in on the day. A patient who agreed is sent one SMS reminder the day before; it names neither the clinic nor the reason. | Appointment | `src/lib/appointments.ts`, `src/lib/appointment-reminders.ts` | `src/routes/appointments.test.ts` |
| Vital signs | Records temperature, pulse, respiratory rate, blood pressure, SpO2, weight, height, MUAC, blood glucose and pain score, each in one unit. A value no real reading could have is refused, as a typing slip. A wrong reading is marked entered in error with a reason, and stays on the record. | Observation | `src/lib/observations.ts`, `src/lib/vital-signs.ts` | `src/routes/triage.test.ts` |
| Allergies | Records allergies by category, with "no known allergies" kept distinct from "not asked". A drug allergy may name the catalogue drug. Prescribing that drug is refused unless the prescriber gives a reason, which is audited and printed. | AllergyIntolerance | `src/lib/allergies.ts`, `src/lib/prescriptions.ts` | `src/routes/triage.test.ts`, `src/routes/prescriptions.test.ts` |
| Diagnoses | Coded in ICD-11 MMS, loaded unaltered from WHO's release, and searched by name. Each diagnosis copies the code, title, URI and release as diagnosed, so a later release never changes the record. Diagnoses are provisional or confirmed, principal or secondary, and ruled out or marked entered in error rather than deleted. | Condition | `src/lib/diagnoses.ts`, `src/lib/icd11.ts`, `src/lib/icd11-load.ts` | `src/routes/diagnoses.test.ts`, `src/lib/icd11.test.ts` |
| Clinical notes | Consultation notes in the sections of an outpatient card, and nursing notes. A note is its author's draft until signed and frozen once signed. Corrections are addenda, and a note on the wrong patient is marked entered in error. | Composition | `src/lib/notes.ts` | `src/routes/notes.test.ts` |
| Orders | Orders laboratory tests and services (procedures, imaging), routine or urgent. Each is charged as it is ordered, from the facility's price list, and cancelled with its charge while that charge is unbilled. Walk-in clients are served on an outside requester's form, or on their own request, marked as such. | ServiceRequest | `src/lib/orders.ts`, `src/lib/charges.ts` | `src/routes/orders.test.ts` |
| Prescriptions | Prescribes from a drug catalogue at generic level: dose, route, frequency, duration, and a quantity worked out from them. Controlled drugs are prescribed by doctors and clinical officers only. A child under 12 needs a weight taken that day. Each prescription prints with a number, the prescriber's licence, the patient's allergies and a verification QR code. | MedicationRequest | `src/lib/prescriptions.ts`, `src/lib/drug-catalogue.ts` | `src/routes/prescriptions.test.ts` |
| Laboratory catalogue | Each facility sets up its own tests, with analytes that are numbers (a unit, reference ranges by sex and age, critical limits), a choice from a list, or free text. No test menu or reference range is supplied by the system. | ActivityDefinition, ObservationDefinition | `src/lib/lab-catalogue.ts` | `src/routes/lab-tests.test.ts` |
| Specimens | The laboratory's worklist shows tests to collect, specimens to receive and results to verify, urgent first. Each specimen takes a daily accession number. Specimens are received, rejected for a listed reason, and recollected. A test not yet paid for shows a warning and is never blocked. | Specimen | `src/lib/specimens.ts` | `src/routes/specimens.test.ts` |
| Results and reports | Results are entered per analyte, flagged against the range for the patient's sex and age, and frozen with the range applied. Another laboratory member verifies each one. A critical value is not released until who was told, how and when is recorded. A correction is a new version. Each order's numbered report is printed with a verification QR code. | Observation, DiagnosticReport | `src/lib/lab-results.ts` | `src/routes/lab-results.test.ts` |
| Closing a visit | A visit closes itself once the patient is in no queue, every test is resulted, nothing is owed, and the patient was seen or tested. Visits still open overnight are closed. | Encounter | `src/lib/visit-finish.ts`, `src/jobs/visits.ts` | `src/routes/visit-finish.test.ts` |
| Sensitive records | HIV, mental health and gender-based violence records are restricted. Each is seen by the clinician who recorded it, by staff the facility assigns to its category, and by a clinician who "breaks the glass". Breaking the glass needs a stated reason, opens that patient's restricted records for 12 hours, alerts those who recorded them, and is reviewed by the facility admin. Everyone else sees only that a restricted record exists. Bills can print a neutral name for a sensitive item. | Consent, AuditEvent | `src/lib/sensitivity.ts` | `src/routes/sensitive-records.test.ts` |
| Printed documents | Prescriptions and laboratory reports are frozen when issued, numbered from gap-free series, and printed with a QR code. The code verifies the document on a public page that shows no patient data. A document is changed by voiding it, never by editing it. | DocumentReference | `src/lib/documents.ts`, `src/lib/verification.ts` | `src/routes/documents.test.ts`, `src/routes/prescriptions.test.ts` |

## Controls that apply to every function

- **Who sees clinical data:** only clinical roles read notes, diagnoses, orders and results. A records clerk or cashier sees the queues and the bill, not the clinical record.
- **Every read is audited, not only every change:** each opening of a clinical record, list or document writes an audit entry naming the person, inside the same database transaction as the read. The audit log is append-only: the application's database role can only insert and read it, and a trigger refuses changes from every role. A refused attempt to break the glass, and a refused restricted document, are recorded too.
- **Nothing clinical is deleted:** readings, diagnoses, notes, orders, specimens and results are ended, marked entered in error or superseded, never removed. Database triggers enforce this for every role, and tests prove it.
- **Separation between facilities:** each facility's records are isolated in the database by row-level security, proven in `src/db/rls.test.ts`.
- **No patient data outside the database:** logs, queue messages and file names carry identifiers only (`CLAUDE.md` rule 10).
- **Encryption:** see [encryption.md](encryption.md).

## Not yet, and why

| Gap | Status |
|---|---|
| Drug-interaction and dose checking | Needs a licensed drug-knowledge source; none is chosen for v1 |
| Drug catalogue content | Built for PPB's Generic Products list, which DHA's ePrescription guide requires. Loading it waits on PPB's or DHA's terms and an export, and on a pharmacist's review |
| Dispensing and the controlled-drug register | P4 (pharmacy and stores) |
| Inpatient care: ward rounds, nursing charts, the NEWS2 early-warning score, medication administration, discharge summaries | P5 |
| Checks against the national registries (client, facility, health worker) | Through AfyaConnect, once access is granted (`SPEC.md` §10) |
| A FHIR interface | Not in v1; the data model follows FHIR names so one can be added |
| Clinical confirmation of three settings | The list of sensitive ICD-11 codes (including the GBV codes still to be named), and the age below which a weight is required to prescribe (12). Both are to be confirmed by a clinician |
| Abnormal vital-sign flags for outpatients | Proposed: children's thresholds depend on age and need clinical input |
