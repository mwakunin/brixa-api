---
paths:
  - "**/*.ts"
---
# TypeScript Hooks

> This file extends [common/hooks.md](../common/hooks.md) with TypeScript specific content.
> Adapted for this repository from ecc 2.2.3. The root `CLAUDE.md` takes precedence over it.

No hooks are configured for this repository yet. If any are added, put them in the project's `.claude/settings.json`.

## PostToolUse Hooks

- **Format**: `pnpm exec eslint --fix <file>`. The antfu ESLint config formats this codebase; do not run Prettier, which disagrees with it.
- **Type check**: `pnpm typecheck` after editing `.ts` files.

## Stop Hooks

- **Console audit**: `pnpm lint` already warns on `console` through `no-console`.
