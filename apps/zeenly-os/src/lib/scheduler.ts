/**
 * The scheduler: which units have something to do, and one Claude Code
 * session for each, deepest first, with a token that acts only as that unit
 * and the tools its capabilities allow. Each session's full output goes to a
 * file; what it cost and how it ended goes on the unit's activity stream.
 * Runs inside the server, which owns the database.
 */

import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  env,
  issueToken,
  listCapabilities,
  listUnits,
  pendingUnits,
  recordRun,
  revokeToken,
  SCHEDULER,
} from "@zeenly-os/core";

import { mcpConfig, prompt, readResult, toolFlags } from "./claude";

export type SchedulerSettings = {
  /** Where this server answers, for the sessions' MCP config. */
  baseUrl: string;
  /** The most one session may spend, in dollars. */
  budgetUsd: number;
  /** The most turns one session may take. */
  maxTurns: number;
  /** The `claude` command to run. */
  claude: string;
  /** Where sessions run. */
  cwd: string;
  /** Minutes between passes. */
  everyMinutes: number;
};

/** Settings from the environment, with their defaults. */
export function settings(): SchedulerSettings {
  const port = Number(process.env.ZEENLY_OS_PORT ?? process.env.PORT ?? 3000);
  return {
    baseUrl: process.env.ZEENLY_OS_URL ?? `http://localhost:${port}`,
    budgetUsd: Number(process.env.ZEENLY_OS_BUDGET_USD ?? 2),
    maxTurns: Number(process.env.ZEENLY_OS_MAX_TURNS ?? 40),
    claude: process.env.ZEENLY_OS_CLAUDE ?? "claude",
    cwd: process.env.ZEENLY_OS_CWD ?? process.cwd(),
    everyMinutes: Number(process.env.ZEENLY_OS_EVERY ?? 10),
  };
}

export type PassResult = {
  ran: { unit: string; reasons: string[] }[];
  /** A pass was already under way, so this one did nothing. */
  busy: boolean;
};

const TOKEN_TTL_MS = 3 * 60 * 60 * 1000;

let passing = false;

/** One pass: every unit with work runs once. Never two passes at a time. */
export async function runPass(
  options: SchedulerSettings = settings(),
  log: (line: string) => void = defaultLog,
): Promise<PassResult> {
  if (passing) return { ran: [], busy: true };
  passing = true;
  try {
    const pending = await pendingUnits();
    if (!pending.length) {
      log("Nothing pending.");
      return { ran: [], busy: false };
    }
    const names = new Map((await listUnits()).map((u) => [u.id, u.name]));
    for (const p of pending) {
      log(
        `${names.get(p.unit) ?? p.unit} (${p.unit}): ${p.reasons.join("; ")}`,
      );
      await runUnit(p.unit, options, log);
    }
    return { ran: pending, busy: false };
  } finally {
    passing = false;
  }
}

let loop: NodeJS.Timeout | undefined;

/** Passes now and every `everyMinutes`, until the process ends. */
export function startLoop(
  options: SchedulerSettings = settings(),
  log: (line: string) => void = defaultLog,
): void {
  if (loop) return;
  const tick = () => {
    runPass(options, log).catch((err) =>
      log(`error: ${err instanceof Error ? err.message : String(err)}`),
    );
  };
  tick();
  loop = setInterval(tick, options.everyMinutes * 60_000);
  loop.unref();
}

/** Wakes one unit's agent in a session of its own. */
export async function runUnit(
  unit: string,
  options: SchedulerSettings,
  log: (line: string) => void = defaultLog,
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
  log(
    `  ${outcome}${result?.costUsd != null ? ` · $${result.costUsd.toFixed(2)}` : ""}${result?.turns != null ? ` · ${result.turns} turns` : ""}${detail ? ` · ${detail}` : ""} · ${logPath}`,
  );
}

function defaultLog(line: string): void {
  console.log(`[scheduler ${new Date().toISOString()}] ${line}`);
}
