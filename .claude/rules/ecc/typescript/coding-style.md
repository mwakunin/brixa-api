---
paths:
  - "**/*.ts"
---
# TypeScript Coding Style

> This file extends [common/coding-style.md](../common/coding-style.md) with TypeScript specific content.
> Adapted for this repository from ecc 2.2.3. The root `CLAUDE.md` takes precedence over it.

## Types and Interfaces

### Public APIs

- Add parameter and return types to exported functions, shared utilities, and public class methods
- Let TypeScript infer obvious local variable types
- Extract repeated inline object shapes into named types or interfaces

```typescript
// WRONG: Exported function without explicit types
export function formatUser(user) {
  return `${user.firstName} ${user.lastName}`;
}

// CORRECT: Explicit types on public APIs
interface User {
  firstName: string;
  lastName: string;
}

export function formatUser(user: User): string {
  return `${user.firstName} ${user.lastName}`;
}
```

### Interfaces vs. Type Aliases

- Use `interface` for object shapes that may be extended or implemented
- Use `type` for unions, intersections, tuples, mapped types, and utility types
- Use string literal unions, never `enum`. A union stored in a text column also needs a matching `CHECK` (`CLAUDE.md` rule 15)

```typescript
type EncounterKind = "opd" | "emergency" | "ipd";
```

### Avoid `any`

- Avoid `any` in application code
- Use `unknown` for external or untrusted input, then narrow it safely
- Use generics when a value's type depends on the caller

```typescript
// WRONG: any removes type safety
function errorName(error: any) {
  return error.name;
}

// CORRECT: unknown forces safe narrowing
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
```

## Immutability

Use spread operator for immutable updates:

```typescript
// WRONG: Mutation
function rename(user: User, name: string): User {
  user.name = name;
  return user;
}

// CORRECT: Immutability
function rename(user: Readonly<User>, name: string): User {
  return { ...user, name };
}
```

## Error Handling

A database error's message carries its SQL and its parameters, so it can hold patient data. It must never reach a log line, a response body or a stored column (`CLAUDE.md` rule 10).

- A lib module refuses by throwing its own error class with a `code` union (`PatientError`, `EncounterError`, `BillingError`). Do not return error values.
- A handler catches its module's error class, plus any database constraint violations it recognizes (`isCheckViolation` and `pgConstraintName` from `src/lib/db-errors.ts`, as the patients handler does), and maps them to the refusals its route declares. A not-found code answers 404 with `{ message }` only, so a stranger learns nothing. Anything else is rethrown.
- Unexpected errors go to `onError` ([src/lib/on-error.ts](../../../../src/lib/on-error.ts)), which logs `summarizeError(err)` and answers with a fixed message and the request id. Do not catch an error just to log it and rethrow.
- When logging or storing an error yourself, use `summarizeError` (log) or `errorLine` (a column such as `outbox.last_error`) from `src/lib/error-summary.ts`. Never log `err`, `err.message` or `err.detail`.
- If you must wrap an error, pass `{ cause: err }` so the original is kept.

```typescript
// lib: refuse with the module's error class (src/lib/encounters.ts, shortened)
export class EncounterError extends Error {
  constructor(readonly code: "not_found" | "bed_not_found" | "bed_occupied") {
    super(/* a message per code, written for the caller */);
    this.name = "EncounterError";
  }
}

// handler: map the module's refusals, rethrow the rest (encounters.handlers.ts)
const NOT_FOUND = new Set(["not_found", "bed_not_found"]);

function refusal(c: Context<TenantBindings>, err: unknown) {
  if (!(err instanceof EncounterError))
    return null;
  if (NOT_FOUND.has(err.code))
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
  return c.json({ message: err.message, code: err.code }, HttpStatusCodes.CONFLICT);
}
```

## Input Validation

- Request bodies, params and queries are validated by the route's Zod schemas (`createRoute` from `@hono/zod-openapi`). Handlers read them with `c.req.valid("json" | "param" | "query")`, never `c.req.json()`.
- Parse other external input (M-Pesa callbacks, payer responses) with Zod too, starting from `unknown`.
- Infer types from schemas with `z.infer`.

## Console

- Log with the pino logger (`c.var.logger` in a request, [src/lib/logger.ts](../../../../src/lib/logger.ts) elsewhere), which redacts.
- `console` belongs only in CLI scripts and process start-up, where ESLint's `no-console` warning is accepted.
