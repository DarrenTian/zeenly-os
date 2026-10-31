/**
 * `zeenly-os`: the pages and the scheduler in one command.
 *
 *   zeenly-os                 start the pages, then wake units every 10 minutes
 *   zeenly-os serve           the pages only
 *   zeenly-os run [--once]    wake units now; without --once, keep going
 *   zeenly-os token <person>  a token for your own tools, acting as you
 *
 * Settings come from the environment: ZEENLY_OS_PORT (3000),
 * ZEENLY_OS_DATA (~/.zeenly-os), ZEENLY_OS_BUDGET_USD per session (2),
 * ZEENLY_OS_MAX_TURNS per session (40), ZEENLY_OS_EVERY minutes (10),
 * ZEENLY_OS_CLAUDE (claude), DATABASE_URL for a Postgres instead of the
 * embedded database.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import { databaseInfo, issueToken, migrateDb } from "@zeenly-os/core";

import { runOnce } from "./run";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    once: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const port = Number(process.env.ZEENLY_OS_PORT ?? 3000);
const baseUrl = process.env.ZEENLY_OS_URL ?? `http://localhost:${port}`;
const every = Number(process.env.ZEENLY_OS_EVERY ?? 10) * 60_000;
const runOptions = {
  baseUrl,
  budgetUsd: Number(process.env.ZEENLY_OS_BUDGET_USD ?? 2),
  maxTurns: Number(process.env.ZEENLY_OS_MAX_TURNS ?? 40),
  claude: process.env.ZEENLY_OS_CLAUDE ?? "claude",
  cwd: process.cwd(),
  log: (line: string) =>
    console.log(`[run ${new Date().toISOString()}] ${line}`),
};

const command = positionals[0] ?? "start";

if (values.help || command === "help") {
  console.log(`zeenly-os                 start the pages, then wake units every ${every / 60_000} minutes
zeenly-os serve           the pages only
zeenly-os run [--once]    wake units now; without --once, keep going
zeenly-os token <person>  a token for your own tools, acting as you`);
  process.exit(0);
}

await migrateDb();
const database = databaseInfo();

switch (command) {
  case "start":
    serve();
    console.log(
      `zeenly-os at ${baseUrl} · ${database.kind} database at ${database.where}`,
    );
    await loop();
    break;
  case "serve":
    serve();
    console.log(
      `zeenly-os at ${baseUrl} · ${database.kind} database at ${database.where}`,
    );
    break;
  case "run":
    if (values.once) await runOnce(runOptions);
    else await loop();
    break;
  case "token": {
    const person = positionals[1];
    if (!person) {
      console.error(
        "zeenly-os token <person>: whose token (your name in the company)",
      );
      process.exit(2);
    }
    const issued = await issueToken(
      { actor: { kind: "human", id: person }, label: "cli", ttlMs: null },
      { kind: "human", id: person },
    );
    console.log(issued.token);
    console.log(
      `\nActs as ${person}. For Claude Code:\n  claude mcp add --transport http zeenly ${baseUrl}/api/mcp --header "Authorization: Bearer ${issued.token}"`,
    );
    break;
  }
  default:
    console.error(`No command "${command}"; try zeenly-os help`);
    process.exit(2);
}

/** Starts Next.js in this package: the built app if there is one, else dev. */
function serve(): void {
  const require = createRequire(import.meta.url);
  const next = require.resolve("next/dist/bin/next");
  const appDir = dirname(require.resolve("../../package.json"));
  const built = (() => {
    try {
      require.resolve("../../.next/BUILD_ID");
      return true;
    } catch {
      return false;
    }
  })();
  const child = spawn(
    process.execPath,
    [next, built ? "start" : "dev", "--port", String(port)],
    { cwd: appDir, stdio: "inherit", env: { ...process.env } },
  );
  child.on("exit", (code) => process.exit(code ?? 0));
}

/** Wakes units now and every `every` milliseconds, until stopped. */
async function loop(): Promise<void> {
  for (;;) {
    try {
      await runOnce(runOptions);
    } catch (err) {
      console.error(
        `[run] ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await new Promise((r) => setTimeout(r, every));
  }
}
