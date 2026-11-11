# Deployment

What the API needs from Google Cloud before it can run in production. The code refuses to start without the settings marked *required* (`src/env.ts`). Where something depends on the data-residency answer (`SPEC.md` §4, question 1), it says so: the region and the bucket location are not decided yet.

## 1. Cloud Run service

- **Image:** the `Dockerfile` in this repository. Run migrations as a separate release step from the same image (`node ./dist/src/db/migrate.js`), never at container start.
- **Startup and readiness probe:** an HTTP probe on `/health`. It answers 503 until every database connection works and the role check has passed. The default TCP probe passes as soon as the port opens, and requests would then meet the startup gate's 503.
- **Secrets** come from Secret Manager, never from the image: `BETTER_AUTH_SECRET`, the three database URLs, `REDIS_URL`, `RESEND_API_KEY`.

| Variable | Production value |
|---|---|
| `NODE_ENV` | `production` (set by the image) |
| `BETTER_AUTH_URL` | The API's HTTPS URL. Cloud Tasks and Cloud Scheduler call it, and identity tokens are minted for its origin |
| `APP_URL` | The staff app's HTTPS origin |
| `TRUST_PROXY_HOPS` | `1` behind Cloud Run alone |
| `DATABASE_URL`, `APP_DATABASE_URL`, `AUTH_DATABASE_URL` | Three different roles (`db/roles.sql`); TLS is enforced (`src/db/connection.ts`) |
| `REDIS_URL` | Upstash, `rediss://` (TLS required) |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | Required |
| `STORAGE_DRIVER`, `STORAGE_BUCKET` | `gcs`, and the bucket in §4 |
| `TASKS_QUEUE`, `TASKS_INVOKER_EMAIL` | The queue and service account in §2 |
| `CREDENTIALS_ENCRYPTION_KEY` | Base64 of 32 random bytes, from Secret Manager: encrypts each facility's Daraja credentials. Losing it means every facility re-enters them |
| `MPESA_ENV` | `sandbox` until the first facility goes live, then `production`. It is one setting for the whole deployment: once it is `production`, every facility's prompts and URL registrations go to Safaricom's live host, so a facility still testing on sandbox credentials stops working. Switch it once, when the first facility goes live, and onboard every later facility with live credentials; test on staging, which keeps `sandbox` |
| `MPESA_CALLBACK_ALLOWED_IPS` | Optional: Safaricom's published callback addresses. Advisory, never used to refuse |

**M-Pesa callback URLs carry a secret.** Each facility's `/webhooks/mpesa/{token}/…` path holds the token that lets a caller post payment confirmations for it. The API never writes it to its own logs (`loggedPath`) or to `gateway_exchanges`, but **Cloud Run's request logs record every request URL**. Add a Cloud Logging exclusion for `httpRequest.requestUrl =~ "/webhooks/mpesa/"` on the `run.googleapis.com/requests` log, or restrict who may read it.

## 2. Background jobs

Every external call is an outbox row, drained by `POST /internal/outbox/drain` (`src/routes/internal.route.ts`). That route accepts only a Google-signed identity token for `TASKS_INVOKER_EMAIL`, minted for the API's origin. The API is public, because the staff app calls it from browsers, so this check, not Cloud Run's IAM, is what keeps the route closed.

1. **Invoker service account**, e.g. `tasks-invoker@PROJECT.iam.gserviceaccount.com`, with no roles of its own. It only identifies the caller. Its email is `TASKS_INVOKER_EMAIL`.
2. **Cloud Tasks queue** in the service's region, e.g. `projects/PROJECT/locations/REGION/queues/outbox`. Its path is `TASKS_QUEUE`. After each commit that queues a job, the API creates one task named `outbox-{jobId}`, so a duplicate is refused.
3. **Cloud Scheduler job**, the sweep, every minute: `POST {BETTER_AUTH_URL}/internal/outbox/drain` with an OIDC token for the invoker account, audience set to the API's origin. It retries backed-off jobs and delivers anything a task missed.
4. **Cloud Scheduler job**, the nightly bed-day run, at 00:15 Africa/Nairobi: `POST {BETTER_AUTH_URL}/internal/jobs/bed-days`, with the same OIDC token and audience. It charges every open admission's nights so far; it is idempotent, so a retry or a second run charges nothing twice.
5. **Cloud Scheduler job**, the daily reconciliation check, at 02:00 Africa/Nairobi: `POST {BETTER_AUTH_URL}/internal/jobs/reconciliation`, same token and audience. It checks every facility's money identities (M2, M3, M4, M-Pesa); a finding stays in `job_failures` until fixed, and is logged as `money identities drifted`, which should alert.

6. **Cloud Scheduler job**, the nightly close of outpatient visits, at 03:00 Africa/Nairobi: `POST {BETTER_AUTH_URL}/internal/jobs/close-visits`, same token and audience. It closes every outpatient visit opened before that day and still open, so yesterday's patients leave the queues; emergency attendances and admissions are left alone. A facility's failure stays in `job_failures` until a later run for it succeeds.

   The three nightly jobs (steps 4 to 6) need **retries**: Cloud Scheduler's default is none, so a run that fails as a whole (the database unreachable before any facility is checked) would wait for the next night. Set e.g. `--max-retry-attempts=3 --min-backoff=5m --max-backoff=30m`. All three are idempotent, so a retry repeats nothing.
7. **IAM for the Cloud Run runtime service account:**
   - `roles/cloudtasks.enqueuer` on the queue
   - `roles/iam.serviceAccountUser` on the invoker account, so a task can carry its token
8. **Alerts** (log-based, on the JSON lines the API writes):
   - `jsonPayload.msg = "money identities drifted"`: the daily check found money that does not add up. The line names the facility and the ids; `job_failures` holds each finding until it is fixed.
   - `jsonPayload.msg = "outbox job failed permanently"`: a job will not be retried. The line carries `outboxId`, `facilityId` and `operation`; the row's `last_error` says why.
   - `jsonPayload.msg = "outbox nudge failed; the scheduled sweep will deliver"`: Cloud Tasks could not be reached. Worth a look if it persists.
   - `jsonPayload.msg = "job failed for a facility"`: a nightly job (`job`: `bed_day_accrual`, `reconciliation` or `visit_close`) failed for one facility (`facilityId`). Nights the bed-day run could not price are listed in that facility's `job_failures` instead.
   - **A scheduled job that failed as a whole**: `resource.type = "cloud_scheduler_job"` with `severity >= ERROR`, i.e. the attempt got no 2xx from `/internal/jobs/…` even after its retries. Whether the run finished is unknown: a timeout or a lost response can come after the work committed, or while the handler is still running. Facilities whose transaction committed were checked or charged; any others were not. All three jobs are idempotent, so running the job again by hand completes the night without repeating anything.

## 3. Reference data

**ICD-11**, which diagnoses are coded in, is loaded once per environment and again for each new release (`SCHEMA.md` §8, slice 3a):

1. Download WHO's release file: `https://icdcdn.who.int/static/releasefiles/<release>/SimpleTabulation-ICD-11-MMS-en.zip` (2026-01 at the time of writing; WHO publishes one each January).
2. Unzip it and load the `.txt` inside, unmodified, on the owner connection. From the release image, like the migrations (the image has no `tsx`, so `pnpm icd11:load` works only from a checkout with dev dependencies):

   ```sh
   docker run --rm --env-file .env.production -v "$PWD:/data:ro" <image> \
     node ./dist/src/cli/load-icd11.js /data/SimpleTabulation-ICD-11-MMS-en.txt
   ```

   It reports the release and how many codes it loaded and retired. An older release than one already loaded is refused. So is a file cut short (one that never reaches chapter X, which WHO prints last), and one that would retire more than 5% of the codes in use, since the codes missing from it would be taken out of use. A real release retires a few dozen.

Until it has run, diagnoses cannot be recorded: the code search finds nothing. ICD-11 is © WHO 2019, licensed under CC BY-ND 3.0 IGO.

## 4. File storage

One bucket per environment (`STORAGE_BUCKET`). **Its location cannot be changed after creation, so create it only once the residency answer is in.**

- Uniform bucket-level access, and public access prevention **enforced**
- Object versioning on, and soft delete on
- Data Access audit logs enabled for Cloud Storage (they are off by default)
- The runtime service account holds `roles/storage.objectAdmin` on this bucket only
- The runtime service account holds `roles/iam.serviceAccountTokenCreator` **on itself**: signed URLs are signed through IAM `signBlob`, so no key file exists anywhere

Object keys are `tenants/{facilityId}/.../{uuid}` and name ids only (`src/lib/storage.ts`).

## 5. Database

- PostgreSQL on the host the residency answer chooses (`SPEC.md` §4, question 4), with production and staging on the same kind of host.
- Run `db/roles.sql` once as an administrator, replacing the passwords in the same run (the recipe is in the file).
- The owner role needs `BYPASSRLS` on a managed host. Run the RLS tests against the production host before real data goes in (`CLAUDE.md` §4).
