# CLAUDE.md

Read before starting any task in this repository. Setup and commands are in `README.md`.

zeenly-os is a kernel for running any one-person company as a tree of agent roles. Nothing in it is specific to one company: no company names, domains, repositories or roles belong in the code. Starter data (a template company) is data, not code.

## Architecture

- `packages/core` holds all logic and the database. Apps stay thin: routing, auth and UI only. If you're writing logic in an app, move it to core.
- Agents and people change the tree only through core's functions; the MCP server (`packages/core/src/tree/mcp.ts`) is the agents' way in, and the pages call the same functions.
- `UNIT_PROTOCOL` is what every agent reads on connecting. Change it only when the protocol changes, and keep it short.

## Checks

CI (`.github/workflows/ci.yml`) runs on every PR. Run the same before pushing:

```bash
pnpm format:check   # or `pnpm format` to fix
pnpm lint           # fails on any warning
pnpm typecheck
pnpm test
```

- Tests use Vitest. Database tests use `createTestDb()` (in-memory PGlite), so no Postgres is needed. Tests never call real LLM or network APIs: pass in fakes.
- Run one package with `pnpm --filter @zeenly-os/core test`, one file with `pnpm --filter @zeenly-os/core exec vitest run src/tree/units.test.ts`.
- After editing `packages/core/src/db/schema.ts`, run `pnpm db:generate` and commit the migration in `packages/core/drizzle`. CI fails if they don't match. Never edit a migration that's already on `main`. See Migrations below.
- New logic in core comes with tests next to it (`foo.ts` → `foo.test.ts`).

## Migrations

Every company runs on its own database, and they upgrade one after another, so for a while the previous kernel runs on a database the new one has migrated. A migration therefore only adds: tables, nullable columns or columns with a default, indexes. What takes something away (dropping a table or column, renaming, changing a type, `SET NOT NULL`) goes in a later release, once every company has the additions and no code reads the old shape; its file's first line is `-- contract`. `pnpm db:check` (in CI) enforces this, and that each migration is dated after the one before it, since a database skips any migration older than its newest.

## Commits

- Commit messages and PR titles are a plain sentence saying what changed for the user; the body says why. No `feat:` prefixes except on docs-only changes (`docs: …`).
- Code changes go through PRs; never push to `main`.
