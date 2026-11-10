---
paths:
  - "**/*.ts"
---
# TypeScript Security

> This file extends [common/security.md](../common/security.md) with TypeScript specific content.
> Adapted for this repository from ecc 2.2.3. The root `CLAUDE.md` takes precedence over it.

## Configuration and Secrets

- Read configuration from `@/env`, which is validated with Zod at start-up. Never read `process.env` directly: ESLint's `node/no-process-env` is an error, disabled only in `src/env.ts` and test setup.
- Add a new variable to `EnvSchema` in [src/env.ts](../../../../src/env.ts). A credential production cannot run without also goes in `PRODUCTION_REQUIRED`, so the API refuses to start without it.
- Per-facility secrets (M-Pesa credentials) are stored in the database, encrypted with `encryptSecret` from `src/lib/crypto.ts`, never in env.
- Compare secrets and tokens with `secretEquals` (constant time), never `===`.

```typescript
// NEVER
const apiKey = process.env.RESEND_API_KEY;

// ALWAYS
import env from "@/env";

const apiKey = env.RESEND_API_KEY;
```

## Agent Support

- Use the **security-reviewer** agent for comprehensive security audits
