# zeenly-os

Run a company with a tree of agents, and keep the whole picture in one place.

A company is a tree of **roles** (units). Each role has a charter, a person who steers it, and an agent that works for it. You give the company a **directive**; it flows down the tree, each role translates it into its own goal and tasks, does the work, and **escalates** what it can't decide to the first person above it. Roles **report** upward in fixed fields, citing the reports below them, so nothing is invented. When you overrule a role, the decision becomes a line in its **guidelines**, and that is how the tree learns.

You see the company and its roles, never a pile of sessions.

**Status: early.** The kernel and the first run work end to end; the pages for the desk, the tree and each role are next. Not published to npm yet, so run it from this repository.

## Run it

You need Node 22, pnpm, and [Claude Code](https://code.claude.com) installed and signed in. Nothing else: no database, no account, no settings.

```bash
pnpm install
pnpm --filter zeenly-os cli          # the pages at http://localhost:3000, with the scheduler inside
```

The first visit asks for your company's name, your name, and which roles to start with (engineering, marketing, finance; each with a charter you can edit). Then:

- **Give the company a directive** from the root; the roles translate it, add their tasks and start.
- **The scheduler**, inside the server, wakes every role that has something to do, every 10 minutes, each in its own Claude Code session with a token that acts only as that role and the tools you granted it. Nothing runs when nothing is pending. `zeenly-os run` makes a pass now.
- **Answer what climbs to you**: a role's question lands on your desk; your answer goes back down and into that role's guidelines.

Data lives in `~/.zeenly-os`: an embedded Postgres (one process at a time, so the server owns it and the command line talks to the server), one log file per session, and `token`, the server's token for you, readable by your user only. Settings, all optional, as environment variables: `ZEENLY_OS_PORT` (3000), `ZEENLY_OS_DATA`, `ZEENLY_OS_BUDGET_USD` per session (2), `ZEENLY_OS_MAX_TURNS` per session (40), `ZEENLY_OS_EVERY` minutes (10), `ZEENLY_OS_SCHEDULER=off` to run roles only by hand, `ZEENLY_OS_PASSWORD` to require a sign-in when the server is on the internet, `DATABASE_URL` to use a Postgres server instead.

Subcommands, on a running server: `zeenly-os run` (one scheduler pass now) and `zeenly-os token` (your token, and the `claude mcp add` line that lets your own Claude Code act as you in the tree). The `/token` page mints and revokes tokens too.

## Put it on the internet

The pages and the MCP server run anywhere Next.js does; the scheduler doesn't (it starts Claude Code sessions, so it needs a machine with Claude Code on it). On Vercel:

1. New project from this repository, **Root Directory** `apps/zeenly-os`; the defaults do the rest.
2. A Postgres: Vercel's Neon integration (Storage) sets `STORAGE_DATABASE_URL`, which is read when `DATABASE_URL` isn't set. Migrations run on the first start.
3. Environment variables: `ZEENLY_OS_PASSWORD` (the pages ask for it once per browser; agents use tokens, not the password) and `ZEENLY_OS_SCHEDULER=off`.
4. Deploy, open `/setup`, create the company.

Open `/token` on it for a token that acts as you, with the `claude mcp add` line for your own Claude Code; revoke it there when a machine is gone. Roles then run from a machine of yours: the same repository with the same `DATABASE_URL`, `ZEENLY_OS_URL=https://your.deployment` so sessions reach the hosted MCP server, and `pnpm --filter zeenly-os cli`.

A second company is best a second install with its own database: unit ids (`engineering`, say) are global in a database, so two companies with the same role names would collide. A second root in the same database works when its role ids differ; the home page lists every company you steer.

## Repository layout

pnpm workspace:

- `packages/core` — the kernel: Drizzle schema and migrations (compiled in, so a fresh install migrates itself), the tree's logic, and its MCP server (`handleMcp`). Everything an app or an agent does goes through it.
- `apps/zeenly-os` — the command: the pages (Next.js), `/api/mcp`, and the scheduler that runs roles in Claude Code.

## Development

```bash
pnpm install
pnpm dev                    # pages only, with hot reload
pnpm typecheck
pnpm lint                   # ESLint, fails on any warning
pnpm test                   # Vitest; database tests run on in-memory PGlite
pnpm format                 # Prettier; `pnpm format:check` only checks
pnpm db:generate            # after editing packages/core/src/db/schema.ts: a migration, bundled into src/db/migrations.ts
```

`docker compose up -d` gives a local Postgres for trying `DATABASE_URL`; nothing needs it.

## The tree, in one pass

1. A person issues a directive from a root unit (`directive_issue`).
2. Each unit it reaches translates it into its own goal (`directive_translate`) and adds the tasks it takes (`task_add`). A root's direct children wait for the root's person to confirm their translation; a translation sent back with a note becomes a line in the unit's guidelines.
3. Units work their tasks, and send each other requests (`message_send`). What a unit can't settle it escalates; the escalation climbs to the first unit a person steers.
4. Units report (`report_submit`): status, a headline, done, blocked, next, numbers. A unit whose children have reported cites their report ids in every sentence.
5. The person answers what climbed to them; the answer goes back down, and lands in the asking unit's guidelines.

## Who may do what

Every call carries an **actor**: a unit's agent (`unit:eng`), a person (`human:ada`) or the system (`system:scheduler`). Which one is settled by the bearer token the call came with, never by a parameter. A unit's agent acts as its own unit and reads only its own view; a person acts as any unit they steer, and does what only people do: shape the tree, write a charter or guidelines, confirm a translation, decide an escalation, grant **capabilities** (the tools a unit may use, each a subset of its parent's). The scheduler turns a unit's capabilities into the session's `--tools` and `--allowedTools`; a unit with none can only talk to the tree.

Every change goes through one write entry point, which records an **event** in the same transaction: who, what, on which thing, serving which directive. A unit's activity stream (`unit_events`) is that log, and every session run is on it with its cost and its log file.

`UNIT_PROTOCOL` in `packages/core/src/tree/mcp.ts` is the text every agent gets on connecting, and the full list of tools is `TREE_TOOLS`.

## License

MIT.
