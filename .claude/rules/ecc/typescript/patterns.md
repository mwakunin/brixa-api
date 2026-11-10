---
paths:
  - "**/*.ts"
---
# TypeScript Patterns

> This file extends [common/patterns.md](../common/patterns.md) with TypeScript specific content, and replaces its envelope and repository advice for this repository.
> Adapted for this repository from ecc 2.2.3. The root `CLAUDE.md` takes precedence over it.

## API Response Format

There is no `{ success, data, error, meta }` envelope. Each response's shape is declared on its route with `jsonContent` from `stoker/openapi/helpers`, and status codes come from `stoker/http-status-codes`.

| Outcome | Status | Body |
|---|---|---|
| Success | 200 / 201 | The resource itself, or a named list: `{ encounters: [...] }` |
| Refusal | What the route declares, usually 409 | `{ message, code }` (`RefusalSchema`) |
| Not found, or not yours | 404 | `{ message }` only |
| Validation failure | 422 | Stoker's `defaultHook` shape: `{ success: false, error: { name: "ValidationError", issues } }`. Reuse it when a lib refusal is really about one field |
| Unexpected error | 500 | `{ message, requestId }` from `onError` |

- Instants are ISO strings, dates are `YYYY-MM-DD`, money is an integer field ending in `Cents`.
- A list that pages takes `offset` in its query.

## Data Access

There are no repository classes. Domain logic lives in plain functions in `src/lib/<module>.ts`.

- Each function takes the tenant transaction first: `openEncounter(tx: AppDb, facilityId, input, actor, at = new Date())`.
- Handlers pass `c.var.db`. They never import the owner `db` (`CLAUDE.md` rule 2).
- There are no delete functions. Records are status-transitioned, reversed or superseded (rule 5).
- Code that locks money rows follows the one lock order, `SCHEMA.md` M8 (rule 23).
- Handlers stay thin: read the validated input, call the lib function, shape the JSON.

```typescript
export const getEncounter: TenantRouteHandler<GetEncounterRoute> = async (c) => {
  const { id } = c.req.valid("param");
  try {
    const found = await encounters.viewEncounter(c.var.db, c.var.facility.id, id, actorOf(c));
    return c.json(encounterJson(found), HttpStatusCodes.OK);
  }
  catch (err) {
    const refused = refusal(c, err); // the module's refusals, see coding-style.md
    if (refused)
      return refused as never;
    throw err;
  }
};
```
