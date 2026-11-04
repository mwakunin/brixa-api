# Encryption in transit and at rest

Status as of P1 (2026-11-04). The Digital Health Regulations 2025 name encryption at rest and in transit as a certification prerequisite (`CLAUDE.md` §9). Each control below is enforced in code or configuration, and most are proven by a test that fails if the control is removed.

## In transit

Every connection that leaves the machine and carries health data or credentials is encrypted, and the application refuses to start in production if one is configured without encryption.

The one exemption is a database on the loopback interface (`localhost`, `127.0.0.1`, `::1`, `[::1]`), whose traffic never leaves the machine (`isLocalDatabase` in `src/db/connection.ts`). In production that would be a database proxy such as the Cloud SQL Auth Proxy, if one is used: it listens locally and itself encrypts the connection to the database.

| Connection | Control | Where | Proven by |
|---|---|---|---|
| Browser → API | HTTPS, terminated by Cloud Run's managed TLS. HSTS on every response (`max-age=31536000; includeSubDomains`), so a browser will not use plain HTTP again | `src/lib/create-app.ts` (`hardenedHeaders`) | `src/app.test.ts` ("every response") |
| API → PostgreSQL | TLS with certificate verification on every remote connection. A connection string that turns TLS or verification off (`sslmode=disable`, `no-verify`, and the libpq-compatible forms) stops the API at startup | `src/db/connection.ts` (`sslConfigFor`) | `src/db/connection.test.ts` |
| API → Redis | TLS (`rediss://`) required in production. Redis holds rate-limit counters only, never patient data (`CLAUDE.md` §7) | `src/env.ts` | The API refuses to start in production with `redis://` |
| API → Cloud Storage, Cloud Tasks, Google identity | HTTPS through Google's client libraries; no plain-HTTP endpoint exists | `src/lib/storage-gcs.ts`, `src/lib/cloud-tasks.ts`, `src/lib/invoker-auth.ts` | n/a |
| API → Resend (email) | HTTPS through the provider's SDK | `src/lib/email.ts` | n/a |
| Cloud Tasks / Scheduler → API | HTTPS, carrying a Google-signed identity token checked for issuer, audience, expiry and account | `src/lib/invoker-auth.ts`, `src/routes/internal.route.ts` | `src/routes/internal.test.ts` |
| Signed download URLs | HTTPS Cloud Storage URLs, V4-signed, valid at most 15 minutes, never stored | `src/lib/storage.ts`, `src/lib/storage-gcs.ts` | `src/lib/storage-gcs.test.ts` |
| Links in emails (invitations) | Production requires an `https://` staff app origin | `src/env.ts` | Startup refusal |

## At rest

At-rest encryption comes from the hosting platform. **The production host is not chosen yet**: it waits on the data-residency answer (`SPEC.md` §4, questions 1 and 4). What each candidate gives:

| Store | Holds | If Google Cloud (Johannesburg) | If a Kenyan host |
|---|---|---|---|
| PostgreSQL | All records | Cloud SQL encrypts data, backups and replicas at rest by default (AES-256, Google-managed keys) | **To confirm** with the provider, including backups |
| Object storage | Uploaded files (from P2/P3) | Cloud Storage encrypts every object by default; versions and soft-deleted objects included | **To confirm** |
| Redis (Upstash) | Rate-limit counters only, keyed by HMACs | Not health data. Upstash's at-rest encryption **to confirm** | Same |
| Logs | Request lines with ids, no patient data (`CLAUDE.md` rule 10) | Cloud Logging encrypts at rest by default | **To confirm** |

## Inside the application

These hold regardless of the host:

- **Passwords** are stored only as scrypt hashes (Better Auth), in tables only the auth role can read (`db/roles.sql`).
- **Invitation tokens** are stored only as SHA-256 hashes; the token itself exists only in the emailed link (`src/lib/invitations.ts`).
- **Document verification codes** are 160 random bits; the public verify endpoint discloses no patient data (`SCHEMA.md` §6.2).
- **Rate-limit keys** are HMACs of the address or email, never the value itself (`src/middlewares/rate-limit.ts`).
- **Secrets** come from the environment (Secret Manager in production), never the repository or the image (`docs/deployment.md` §1).
- **Signed URLs** are signed through IAM `signBlob`, so no private key file exists to leak (`docs/deployment.md` §3).

## Open

- **The host**, and with it confirmation of at-rest encryption for the database, its backups and object storage (above).
- **Whether DHA requires customer-managed keys** (CMEK) rather than provider-managed ones. Unknown until the certification guide is read (`SPEC.md` §4, question 11).
- **M-Pesa credentials** will be stored encrypted (AES-256-GCM, ported from the school SaaS's `crypto.ts`) when Daraja arrives in P2.
- **Africa's Talking (SMS) and Daraja** connections will be added to the in-transit table when they arrive.
