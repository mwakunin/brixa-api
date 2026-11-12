# Loading the drug catalogue

Prescriptions are written from the drug catalogue (`drug_catalogue`): one row per medicine at generic level, with its strength, form, dose unit, usual route and, for a controlled drug, its schedule. The catalogue is shared by every facility and read-only to the app. Someone with the database owner's credentials loads it into each environment (local, staging, production) and reloads it when the list changes.

Until a list is loaded, nothing can be prescribed: the drug search (`GET /drugs`) finds nothing.

## Where the list comes from

The catalogue is filled from the Pharmacy and Poisons Board's **Generic Products** list (decided 2026-11-12, `SPEC.md` §2). That is the list the Digital Health Agency's ePrescription guide requires a prescribed medicine's code to come from. Each product has a code and a one-line name, for example `GE10002` "Metformin 500 mg Oral Tablet".

DHA's guide publishes a copy of the list as a FHIR CodeSystem. That copy comes from a draft build of the guide (v0.1.0). PPB's terminology in it is "subject to separate terms" that have not been confirmed. Using it for development and testing is agreed. Loading it into production should wait for confirmation of PPB's or DHA's terms, ideally with an official, versioned export.

## The steps

| Step | Command | Touches the database? |
|---|---|---|
| 1. Get the list | `curl` | No |
| 2. Convert it | `pnpm drugs:convert` | No |
| 3. Review it | a spreadsheet | No |
| 4. Load it | `pnpm drugs:load`, or the release image | Yes, as the owner |

### 1. Get the list

```sh
curl -o generic-products-cs.json \
  https://build.fhir.org/ig/IntelliSOFT-Consulting/Kenya-ePrescription-IG/CodeSystem-generic-products-cs.json
```

The converter refuses any other code system: the file's `url` must be `https://fhir.dha.go.ke/terminology/CodeSystem/generic-products-cs`.

### 2. Convert it

```sh
pnpm drugs:convert generic-products-cs.json drugs.csv drugs-review.csv
```

The command needs three different paths; it refuses to overwrite the list or one output with the other. It writes two files:

- **`drugs.csv`**, the catalogue in the format the loader reads (below);
- **`drugs-review.csv`**, the products a pharmacist should look at before loading.

The converter reads each product's name into a generic name, strength, route and form, and takes the dose unit from the form, for example:

| PPB's name | Generic name | Strength | Route | Form | Dose unit |
|---|---|---|---|---|---|
| Metformin 500 mg Oral Tablet | Metformin | 500 mg | oral | Tablet | tablet |
| Artemether 20 mg/Lumefantrine 120 mg Oral Tablet | Artemether/Lumefantrine | 20 mg/120 mg | oral | Tablet | tablet |
| Cefixime 100 mg per 5ml Oral Syrup | Cefixime | 100 mg per 5ml | oral | Syrup | mL |

The copy of 2026-08 converts to 3,004 drugs. It leaves 15 out and lists 286 to check.

### 3. Review it

Open `drugs-review.csv` in a spreadsheet. A name that would read as a formula is prefixed with an apostrophe, so nothing in it runs. Each line is one product and one issue:

| Issue | In `drugs.csv`? | What to do |
|---|---|---|
| No route in the name that this reads | No | A route this system does not have (buccal, intravitreal, epidural) or a name it cannot read. Add the product by hand if the hospital needs it. Several are PPB errors, such as insulin listed as buccal |
| The generic name and strength could not be told apart | No | As above |
| An injection with no route | Yes, as IV | Set `route` to `iv` or `im`. A prescriber can still choose another route on each prescription |
| A vitamin dosed in mg | Yes | Check the strength. It is usually IU or mcg ("Colecalciferol 800 mg" is almost certainly 800 IU) |
| An inhaler given by mouth | Yes | Set `route` to `inhaled` |
| A powder counted in vials with a strength per mL | Yes | Check `dose_unit`: `vial` or `mL` |
| The same product as GE… | Yes | Delete one of the two rows |

Beyond the review list:

- **Fill in controlled schedules.** PPB's list has none. For each controlled drug (morphine, pethidine, diazepam and the like), set `controlled_schedule` to I, II, III or IV under the Pharmacy and Poisons Act. Until it is set, a nurse can prescribe that drug, because only a schedule restricts a drug to doctors and clinical officers.
- **Look beyond the flagged rows.** The checks catch only what they can recognise. A sample of the list also had swapped combination strengths ("Amlodipine 300 mg/Irbesartan 5 mg") and forms that do not exist ("Tamsulosin 0.4 mg Oral Solution"). Errors like these are worth reporting to DHA.

For local development and testing, the review can wait. Before real patients are prescribed from the list, a pharmacist must review it.

### 4. Load it

The loader writes as the database owner (`DATABASE_URL`), because the app's role may only read the catalogue (`CLAUDE.md` rule 1). The database must have migration 0054, which creates the table.

**Locally:**

```sh
docker compose up -d postgres
pnpm db:migrate
pnpm drugs:load drugs.csv
```

**Staging and production**, from the release image, which has no `tsx`:

```sh
docker run --rm --env-file .env.production -v "$PWD:/data:ro" <image> \
  node ./dist/src/cli/load-drug-catalogue.js /data/drugs.csv
```

It prints, for example, `Drug catalogue: 3004 drugs loaded, 0 retired.`

Check the result by searching as any clinician, for example `GET /drugs?q=metformin` with a facility's header.

## Loading again

Run the same load with the new or corrected file.

- Drugs are matched by code and updated in place.
- A code missing from the new file is **retired**, never deleted, since past prescriptions name it. It stops appearing in the search. If the ten-drug development sample was loaded earlier, the first real load retires its ten codes.
- One transaction does it all. A bad row refuses the whole file and leaves the table as it was.
- One load runs at a time, so two runs at once cannot both leave their drugs in use.
- A file that would retire more than a tenth of the drugs in use (or 20, if that is more) is refused, since that usually means a truncated file. If a list really drops that many, raise the limit in `src/lib/drug-catalogue-load.ts` after looking at what it drops.

## The file format

UTF-8 CSV, comma-separated, with this header:

```csv
code,generic_name,strength,form,dose_unit,route,controlled_schedule
GE10002,Metformin,500 mg,Tablet,tablet,oral,
GE11106,Vitamin D3,400 IU,Drops,drop,oral,
MOR-10-INJ,Morphine,10 mg/mL,Injection,mL,im,II
```

| Column | Rule |
|---|---|
| `code` | A–Z, 0–9, `.` `_` `/` `-`, at most 32 characters, unique in the file |
| `generic_name`, `strength`, `form`, `dose_unit` | Not empty. Combinations are joined with `/`; the allergy check matches each part |
| `route` | One of: oral, sublingual, iv, im, sc, intradermal, topical, rectal, vaginal, inhaled, nasal, ophthalmic, otic |
| `controlled_schedule` | I, II, III, IV, or empty for a drug that is not controlled |

A field holding a comma or a quote is quoted, with `""` for a quote inside it. Anything after a closing quote, or a quote inside an unquoted field, refuses the file. `src/test/fixtures/drug-catalogue-sample.csv` is a ten-drug sample for development and tests. It is not a list to prescribe from.

## When a load fails

| Message | Cause |
|---|---|
| `the header must be code,generic_name,…` | The first line is not the header above |
| `row N …` | That row breaks a rule in the table above; the message names the problem |
| `… appears twice` | A code is in the file twice |
| `it would retire N of M drugs in use; is it complete?` | The file is missing many drugs that are loaded now |
| `permission denied for table drug_catalogue` | The command ran as the app's role. Use the owner's `DATABASE_URL` |
| `relation "drug_catalogue" does not exist` | Run the migrations first |

Related: `docs/deployment.md` §3, `SCHEMA.md` §8 (slice 4b), `src/lib/ppb-generics.ts`, `src/lib/drug-catalogue-load.ts`.
