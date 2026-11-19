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

With no mail provider configured, which is the default here, the API does not send email. Instead, it prints each message to its log, starting `[dev email]`. It also keeps a copy as a JSON file in `.dev-mail/` (`DEV_MAIL_DIR`, gitignored), newest last. Either way, the link in an invitation or a password reset can still be followed: by hand, or by brixa-web's `pnpm flows`, which reads the folder. Leave `RESEND_API_KEY` and `RESEND_FROM_EMAIL` unset to keep it that way: with both set, development sends real email through Resend.

The links in those files work, so treat the folder with care:
- **Who can read it.** On Linux and macOS, the folder and its files are made readable by you alone. A `.dev-mail/` made before that may not be: run `chmod -R go-rwx .dev-mail`, or delete it. Windows ignores these permissions, and the folder inherits its parent's. There, before starting the API, point `DEV_MAIL_DIR` at a folder only your account can read, such as one under your user profile.
- **Git.** Only the default `.dev-mail/` is ignored by git. If you set `DEV_MAIL_DIR` elsewhere, put it outside the checkout, or add your own ignore rule before any email is "sent".
- **Clearing it.** Empty the folder whenever you like.

## Seeding

```sh
pnpm db:seed
```

This fills the dev database with **Sample Hospital**, a made-up facility, through the API, so every rule, charge and audit entry is real:

- **Staff:** one member of staff per desk (front desk, triage, doctor, lab, lab supervisor, pharmacy, stores, cashier, finance, admin), each `<desk>@sample-hospital.test`. They all share the password the command prints, and one authenticator (below).
- **Two more facilities,** Sample Hospital, Westside and Sample Hospital, East (suspended), each with its own admin. A relief clerk, `relief@sample-hospital.test`, works at all three, so the staff app's facility picker has something to show.
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
- if any of its three database connections (owner, app, auth) reaches a database that is not on this machine, read as `pg` reads it;
- with `RESEND_API_KEY`, `AT_API_KEY` or `TASKS_QUEUE` set, since it must never send an email or SMS;
- on a database that holds any facility: one seeded already, or a real one tunnelled to `localhost` (an SSH tunnel, the Cloud SQL proxy), which every host check would pass.

### Signing in by hand

Every sign-in asks for a code after the password (`SPEC.md` §2). Every seeded account, and every account the tests make, shares one authenticator secret (`src/dev/two-factor.ts`), so one code works for all of them:

```sh
pnpm dev:code
```

prints the code, which changes every 30 seconds, and the backup codes. brixa-web's `pnpm flows` and `pnpm screens` work the same code out from the same secret.

The staff app asks for the code once brixa-web #10 is in. Before that, sign in through the API: post the email and password to `/api/auth/sign-in/email` and keep the cookie it sets (the challenge), then post `{ "code": "<from pnpm dev:code>" }` to `/api/auth/two-factor/verify-totp` with that cookie and an `Origin` header naming the staff app (`APP_URL`).

The secret is in the code, in the open, and only the seed and the tests give it to an account. `enrolForDevelopment` refuses when `NODE_ENV` is `production`. What keeps it off a real database is the seed's own refusals above (a database not on this machine, one holding a facility, mail or SMS credentials set), the same ones that keep the seed's public password off it. An unset `NODE_ENV` counts as development, so those refusals, not `NODE_ENV`, are the guard. An account you invite by hand in development has no authenticator. The staff app asks it to set one up, with a real authenticator app, once its setup screen is in (brixa-web #10); until then such an account can sign in with its password and do nothing else.

### Starting again

```sh
docker exec hospital-postgres-dev dropdb -U hospital --maintenance-db=postgres --force hospital_dev
docker exec hospital-postgres-dev createdb -U hospital hospital_dev
pnpm db:migrate
pnpm db:seed
```

That empties the dev database only. Its container, its volume and the database roles stay as they are, so no volume name is needed, and the test database is untouched. It empties any drug catalogue you loaded too. The seed then loads the small sample catalogue; to have PPB's list again, reload it with `pnpm drugs:load` (`docs/drug-catalogue.md`) before seeding.
