---
paths:
  - "**/*.ts"
---
# TypeScript Testing

> This file extends [common/testing.md](../common/testing.md) with TypeScript specific content, and overrides its coverage threshold for this repository.
> Adapted for this repository from ecc 2.2.3. The root `CLAUDE.md` takes precedence over it.

## Framework

- Vitest. Every test talks to a real Postgres, the test database on port 5439, which global setup migrates to the head. Do not mock the database: the RLS, triggers and `CHECK`s under test live there.
- Files run one at a time (`fileParallelism: false`), and each test starts from `resetDb()`.
- Build fixtures with [src/test/helpers.ts](../../../../src/test/helpers.ts) (`makeOnboardedFacility`, `signedInUserAt`, `facilityHeaders`) and, for billing, [src/test/hospital.ts](../../../../src/test/hospital.ts).
- Route tests go through the app over HTTP (`app.request`, `postJson`). Lib tests call the function inside `runAsFacility`.
- Lock and race tests use `backendPid` and `waitForBlockedBackend`.
- External services use test doubles. No test reaches SHA, an insurer, Safaricom, email or SMS (`CLAUDE.md` §8).

## Coverage

`pnpm test:coverage` maps code the suite never reaches. It is not a gate, and `vitest.config.ts` sets no threshold, which overrides the 80% in `common/testing.md`.

## E2E Testing

This repository has no UI, so it has no Playwright. Route tests through the full app are the end-to-end layer here. Browser tests belong with the frontend.
