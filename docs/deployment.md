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
| `STORAGE_DRIVER`, `STORAGE_BUCKET` | `gcs`, and the bucket in §3 |
| `TASKS_QUEUE`, `TASKS_INVOKER_EMAIL` | The queue and service account in §2 |

## 2. Background jobs

Every external call is an outbox row, drained by `POST /internal/outbox/drain` (`src/routes/internal.route.ts`). That route accepts only a Google-signed identity token for `TASKS_INVOKER_EMAIL`, minted for the API's origin. The API is public, because the staff app calls it from browsers, so this check, not Cloud Run's IAM, is what keeps the route closed.

1. **Invoker service account**, e.g. `tasks-invoker@PROJECT.iam.gserviceaccount.com`, with no roles of its own. It only identifies the caller. Its email is `TASKS_INVOKER_EMAIL`.
2. **Cloud Tasks queue** in the service's region, e.g. `projects/PROJECT/locations/REGION/queues/outbox`. Its path is `TASKS_QUEUE`. After each commit that queues a job, the API creates one task named `outbox-{jobId}`, so a duplicate is refused.
3. **Cloud Scheduler job**, the sweep, every minute: `POST {BETTER_AUTH_URL}/internal/outbox/drain` with an OIDC token for the invoker account, audience set to the API's origin. It retries backed-off jobs and delivers anything a task missed.
4. **IAM for the Cloud Run runtime service account:**
   - `roles/cloudtasks.enqueuer` on the queue
   - `roles/iam.serviceAccountUser` on the invoker account, so a task can carry its token
5. **Alerts** (log-based, on the JSON lines the API writes):
   - `jsonPayload.msg = "outbox job failed permanently"`: a job will not be retried. The line carries `outboxId`, `facilityId` and `operation`; the row's `last_error` says why.
   - `jsonPayload.msg = "outbox nudge failed; the scheduled sweep will deliver"`: Cloud Tasks could not be reached. Worth a look if it persists.

## 3. File storage

One bucket per environment (`STORAGE_BUCKET`). **Its location cannot be changed after creation, so create it only once the residency answer is in.**

- Uniform bucket-level access, and public access prevention **enforced**
- Object versioning on, and soft delete on
- Data Access audit logs enabled for Cloud Storage (they are off by default)
- The runtime service account holds `roles/storage.objectAdmin` on this bucket only
- The runtime service account holds `roles/iam.serviceAccountTokenCreator` **on itself**: signed URLs are signed through IAM `signBlob`, so no key file exists anywhere

Object keys are `tenants/{facilityId}/.../{uuid}` and name ids only (`src/lib/storage.ts`).

## 4. Database

- PostgreSQL on the host the residency answer chooses (`SPEC.md` §4, question 4), with production and staging on the same kind of host.
- Run `db/roles.sql` once as an administrator, replacing the passwords in the same run (the recipe is in the file).
- The owner role needs `BYPASSRLS` on a managed host. Run the RLS tests against the production host before real data goes in (`CLAUDE.md` §4).
