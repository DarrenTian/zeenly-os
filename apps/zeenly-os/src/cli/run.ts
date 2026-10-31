/**
 * The scheduler: which units have something to do, and one Claude Code
 * session for each, deepest first, with a token that acts only as that unit
 * and the tools its capabilities allow. Each session's full output goes to a
 * file; what it cost and how it ended goes on the unit's activity stream.
 */

import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  env,
  issueToken,
  listCapabilities,
  listUnits,
  migrateDb,
  pendingUnits,
  recordRun,
  revokeToken,
  SCHEDULER,
} from "@zeenly-os/core";

import { mcpConfig, prompt, readResult, toolFlags } from "./claude";

export type RunOptions = {
  /** Where the pages (and so the MCP server) answer. */
  baseUrl: string;
  /** The most one session may spend, in dollars. */
  budgetUsd: number;
  /** The most turns one session may take. */
  maxTurns: number;
  /** The `claude` command to run. */
  claude: string;
  /** Where sessions run: the company's working directory. */
  cwd: string;
  log: (line: string) => void;
};

const TOKEN_TTL_MS = 3 * 60 * 60 * 1000;

/** One pass: every unit with work runs once. Returns how many ran. */
export async function runOnce(options: RunOptions): Promise<number> {
  await migrateDb();
  const pending = await pendingUnits();
  if (!pending.length) {
    options.log("Nothing pending.");
    return 0;
  }
  const names = new Map((await listUnits()).map((u) => [u.id, u.name]));
  for (const p of pending) {
    options.log(
      `${names.get(p.unit) ?? p.unit} (${p.unit}): ${p.reasons.join("; ")}`,
    );
    await runUnit(p.unit, options);
  }
  return pending.length;
}

/** Wakes one unit's agent in a session of its own. */
export async function runUnit(
  unit: string,
  options: RunOptions,
): Promise<void> {
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const dir = join(env().ZEENLY_OS_DATA, "logs", unit);
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, `${stamp}.jsonl`);

  const token = await issueToken(
    {
      actor: { kind: "unit", id: unit },
      label: `run ${stamp}`,
      ttlMs: TOKEN_TTL_MS,
    },
    SCHEDULER,
    { now },
  );
  const { tools, allowed } = toolFlags(await listCapabilities(unit));
  const args = [
    "-p",
    prompt(unit),
    "--output-format",
    "stream-json",
    "--verbose",
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfig(options.baseUrl, token.token),
    // Nothing outside the allowed rules runs; there is nobody to ask.
    "--permission-mode",
    "dontAsk",
    "--tools",
    tools.join(","),
    "--allowedTools",
    ...allowed,
    "--max-budget-usd",
    String(options.budgetUsd),
    "--max-turns",
    String(options.maxTurns),
  ];

  const started = Date.now();
  const lines: string[] = [];
  const file = createWriteStream(logPath);
  const exit = await new Promise<{ code: number | null; error?: Error }>(
    (resolve) => {
      const child = spawn(options.claude, args, {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
      let rest = "";
      child.stdout.on("data", (chunk: Buffer) => {
        file.write(chunk);
        rest += chunk.toString();
        const parts = rest.split("\n");
        rest = parts.pop() ?? "";
        lines.push(...parts);
      });
      child.stderr.on("data", (chunk: Buffer) => file.write(chunk));
      child.on("error", (error) => resolve({ code: null, error }));
      child.on("close", (code) => {
        if (rest) lines.push(rest);
        resolve({ code });
      });
    },
  );
  file.end();
  await revokeToken(token.id, SCHEDULER);

  const result = readResult(lines);
  const outcome = result?.outcome ?? "failed";
  const detail =
    result?.detail ??
    (exit.error
      ? `${options.claude}: ${exit.error.message}`
      : result
        ? null
        : `exited with ${exit.code ?? "a signal"} before a result`);
  await recordRun(
    {
      unit,
      log: logPath,
      outcome,
      costUsd: result?.costUsd ?? null,
      durationMs: result?.durationMs ?? Date.now() - started,
      turns: result?.turns ?? null,
      sessionId: result?.sessionId ?? null,
      detail,
    },
    SCHEDULER,
  );
  options.log(
    `  ${outcome}${result?.costUsd != null ? ` · $${result.costUsd.toFixed(2)}` : ""}${result?.turns != null ? ` · ${result.turns} turns` : ""}${detail ? ` · ${detail}` : ""} · ${logPath}`,
  );
}
