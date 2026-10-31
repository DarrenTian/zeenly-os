# zeenly-os

Run a company with a tree of agents, and keep the whole picture in one place.

A company is a tree of **roles** (units). Each role has a charter, a person who steers it, and an agent that works for it. You give the company a **directive**; it flows down the tree, each role translates it into its own goal and tasks, does the work, and **escalates** what it can't decide to the first person above it. Roles **report** upward in fixed fields, citing the reports below them, so nothing is invented. When you overrule a role, the decision becomes a line in its **guidelines**, and that is how the tree learns.

You see the company and its roles, never a pile of sessions.

**Status: early.** This repository holds the kernel only: the tree, directives, messages, reports, tasks, documents, capabilities, the event log, tokens, and the MCP server agents use. The pages, the `zeenly run` command and a starter company come next. Not ready to use yet.

## Repository layout

pnpm workspace:

- `packages/core` — the kernel: Drizzle schema and migrations, the tree's logic, and its MCP server (`handleMcp`). Everything an app or an agent does goes through it.

## Development

```bash
pnpm install
docker compose up -d        # local Postgres (tests don't need it)
cp .env.example .env
pnpm db:migrate
pnpm typecheck
pnpm lint                   # ESLint, fails on any warning
pnpm test                   # Vitest; database tests run on in-memory PGlite
pnpm format                 # Prettier; `pnpm format:check` only checks
pnpm db:generate            # after editing packages/core/src/db/schema.ts
```

## The tree, in one pass

1. A person issues a directive from a root unit (`directive_issue`).
2. Each unit it reaches translates it into its own goal (`directive_translate`) and adds the tasks it takes (`task_add`). A root's direct children wait for the root's person to confirm their translation; a translation sent back with a note becomes a line in the unit's guidelines.
3. Units work their tasks, and send each other requests (`message_send`). What a unit can't settle it escalates; the escalation climbs to the first unit a person steers.
4. Units report (`report_submit`): status, a headline, done, blocked, next, numbers. A unit whose children have reported cites their report ids in every sentence.
5. The person answers what climbed to them; the answer goes back down, and lands in the asking unit's guidelines.

## Who may do what

Every call carries an **actor**: a unit's agent (`unit:eng`), a person (`human:founder`) or the system (`system:scheduler`). Which one is settled by the bearer token the call came with, never by a parameter. A unit's agent acts as its own unit and reads only its own view; a person acts as any unit they steer, and does what only people do: shape the tree, write a charter or guidelines, confirm a translation, decide an escalation, grant **capabilities** (the tools a unit may use, each a subset of its parent's).

Every change goes through one write entry point, which records an **event** in the same transaction: who, what, on which thing, serving which directive. A unit's activity stream (`unit_events`) is that log.

`UNIT_PROTOCOL` in `packages/core/src/tree/mcp.ts` is the text every agent gets on connecting, and the full list of tools is `TREE_TOOLS`.

## License

MIT.
