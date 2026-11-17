# Development

Running the API on your own machine, with a made-up hospital to work in.

## Running it

```sh
docker compose up -d     # Postgres (dev 5438, test 5439) and Redis (6383)
pnpm install
pnpm db:migrate          # the dev database, to the latest migration
pnpm dev                 # http://localhost:9999; every endpoint at /reference
```

The staff app (`brixa-web`) runs beside it on http://localhost:3000. That is the API's default `APP_URL`, so sign-in works without changing anything.

## Seeding

```sh
pnpm db:seed
```

This fills the dev database with **Sample Hospital**, a made-up facility, through the API, so every rule, charge and audit entry is real:

- **Staff:** one member of staff per desk (front desk, triage, doctor, lab, lab supervisor, pharmacy, stores, cashier, finance, admin), each `<desk>@sample-hospital.test`. They all share the password the command prints.
- **Set-up:** triage, General OPD and the Dental clinic with their fees, a malaria test and a blood count, and a pharmacy stocked with two medicines.
- **Patients**, invented, at every outpatient desk:
  - two waiting at triage, and one at the clinic;
  - one booked for later today;
  - at the lab, one to collect and one to verify;
  - one back at the clinic with her results;
  - at the pharmacy, one to prepare and one to hand over;
  - several with money due at the cashier.

It refuses to run:
- in production;
- against a database that is not on this machine;
- with `RESEND_API_KEY`, `AT_API_KEY` or `TASKS_QUEUE` set, since it must never send an email or SMS;
- on a database seeded already.

### Starting again

```sh
docker compose rm -sf postgres
docker volume rm api_postgres_dev_data
docker compose up -d postgres
pnpm db:migrate
pnpm db:seed
```

That removes the dev database only; the test database is a separate container. It removes any drug catalogue you loaded too. The seed then loads the small sample catalogue; to have PPB's list again, reload it with `pnpm drugs:load` (`docs/drug-catalogue.md`) before seeding.
