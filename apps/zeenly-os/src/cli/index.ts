/**
 * `zeenly-os`: the pages, the tree's MCP server and the scheduler, in one
 * process that owns the database. The command line talks to it over HTTP
 * with the token the server keeps in ZEENLY_OS_DATA/token.
 *
 *   zeenly-os          start it: the pages at http://localhost:3000, the
 *                      scheduler waking units every 10 minutes
 *   zeenly-os run      one scheduler pass now, on a running server
 *   zeenly-os token    your token, and how to point your own Claude at it
 *
 * Settings, as environment variables: ZEENLY_OS_PORT (3000), ZEENLY_OS_DATA
 * (~/.zeenly-os), ZEENLY_OS_BUDGET_USD per session (2), ZEENLY_OS_MAX_TURNS
 * per session (40), ZEENLY_OS_EVERY minutes (10), ZEENLY_OS_SCHEDULER=off,
 * ZEENLY_OS_CLAUDE (claude), ZEENLY_OS_PASSWORD for a server on the
 * internet, DATABASE_URL for a Postgres instead of the embedded database.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import { readLocalToken } from "../lib/local-token";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { help: { type: "boolean", short: "h", default: false } },
});

const port = Number(process.env.ZEENLY_OS_PORT ?? 3000);
const baseUrl = process.env.ZEENLY_OS_URL ?? `http://localhost:${port}`;
const command = positionals[0] ?? "start";

if (values.help || command === "help") {
  console.log(`zeenly-os          start it: the pages at ${baseUrl}, the scheduler waking units
zeenly-os run      one scheduler pass now, on a running server
zeenly-os token    your token, and how to point your own Claude at it`);
  process.exit(0);
}

switch (command) {
  case "start":
    serve();
    break;
  case "run": {
    const reply = await fetch(`${baseUrl}/api/scheduler`, {
      method: "POST",
      headers: { authorization: `Bearer ${await token()}` },
    }).catch((err: Error) => {
      console.error(`Is zeenly-os running at ${baseUrl}? ${err.message}`);
      process.exit(1);
    });
    const body = (await reply.json()) as {
      error?: string;
      busy?: boolean;
      ran?: { unit: string }[];
      log?: string[];
    };
    if (!reply.ok) {
      console.error(body.error ?? `HTTP ${reply.status}`);
      process.exit(1);
    }
    for (const line of body.log ?? []) console.log(line);
    if (body.busy) console.log("A pass is already running.");
    break;
  }
  case "token": {
    const t = await token();
    console.log(t);
    console.log(
      `\nActs as you. To let your own Claude Code use the tree:\n  claude mcp add --transport http zeenly ${baseUrl}/api/mcp --header "Authorization: Bearer ${t}"`,
    );
    break;
  }
  default:
    console.error(`No command "${command}"; try zeenly-os help`);
    process.exit(2);
}

/** The server's token for this install's person; the server writes it on start. */
async function token(): Promise<string> {
  const t = readLocalToken();
  if (t) return t;
  console.error(
    "No token yet: start zeenly-os, set up the company in the browser, and try again.",
  );
  process.exit(1);
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
  console.log(`zeenly-os at ${baseUrl}`);
  const child = spawn(
    process.execPath,
    [next, built ? "start" : "dev", "--port", String(port)],
    {
      cwd: appDir,
      stdio: "inherit",
      env: { ...process.env, ZEENLY_OS_PORT: String(port) },
    },
  );
  child.on("exit", (code) => process.exit(code ?? 0));
}
