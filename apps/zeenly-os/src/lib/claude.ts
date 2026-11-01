/**
 * How a unit's capabilities become a Claude Code session's tools, and how
 * its output is read back. Kept apart from the process handling so it can
 * be tested without running anything.
 */

import type { Capability } from "@zeenly-os/core";

/** The MCP server's name in the session; its tools are mcp__zeenly__*. */
export const MCP_SERVER = "zeenly";

/**
 * Which built-in tools a capability turns on, and the permission rules that
 * let them run without asking. A scope narrows the rule where Claude Code's
 * rule syntax can express it.
 */
const TOOLS: Record<
  string,
  { tools: string[]; allow: (scope: string) => string[] }
> = {
  shell: {
    tools: ["Bash"],
    allow: (scope) => [scope ? `Bash(${scope}:*)` : "Bash"],
  },
  files: {
    tools: ["Read", "Edit", "Write", "Glob", "Grep"],
    allow: (scope) =>
      scope
        ? ["Read", "Edit", "Write", "Glob", "Grep"].map(
            (t) => `${t}(${scope.replace(/\/+$/, "")}/**)`,
          )
        : ["Read", "Edit", "Write", "Glob", "Grep"],
  },
  web: {
    tools: ["WebFetch", "WebSearch"],
    allow: (scope) =>
      scope
        ? [`WebFetch(domain:${scope})`, "WebSearch"]
        : ["WebFetch", "WebSearch"],
  },
  github: {
    tools: ["Bash"],
    allow: (scope) => [scope ? `Bash(gh ${scope}:*)` : "Bash(gh:*)"],
  },
};

/**
 * The flags that give a session exactly its unit's capabilities: `--tools`
 * names the built-ins it may have at all (none, without capabilities), and
 * `--allowedTools` the rules under which they run unasked. The tree's own
 * tools are always allowed.
 */
export function toolFlags(capabilities: Capability[]): {
  tools: string[];
  allowed: string[];
} {
  const tools = new Set<string>();
  const allowed = new Set<string>([`mcp__${MCP_SERVER}`]);
  for (const c of capabilities) {
    const known = TOOLS[c.tool];
    if (!known) continue;
    for (const t of known.tools) tools.add(t);
    for (const rule of known.allow(c.scope)) allowed.add(rule);
  }
  return { tools: [...tools], allowed: [...allowed] };
}

/** The MCP config a session gets: the tree's server, with the unit's token. */
export function mcpConfig(baseUrl: string, token: string): string {
  return JSON.stringify({
    mcpServers: {
      [MCP_SERVER]: {
        type: "http",
        url: `${baseUrl.replace(/\/+$/, "")}/api/mcp`,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  });
}

/** What the session is told; the protocol itself arrives over MCP on connect. */
export function prompt(unit: string): string {
  return `You are the agent of unit "${unit}". Call unit_get for it first, then follow the protocol you received when you connected to the ${MCP_SERVER} server. Stop when nothing in pending is left.`;
}

/** What the end of a stream-json run says, from its final `result` message. */
export type RunResult = {
  outcome: "done" | "failed" | "budget" | "timeout";
  costUsd: number | null;
  durationMs: number | null;
  turns: number | null;
  sessionId: string | null;
  detail: string | null;
};

/**
 * Reads the `result` line of a stream-json transcript. Without one the run
 * ended before Claude finished: a crash, a kill, or a missing `claude`.
 */
export function readResult(lines: string[]): RunResult | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const m = parsed as {
      type?: string;
      subtype?: string;
      is_error?: boolean;
      total_cost_usd?: number;
      duration_ms?: number;
      num_turns?: number;
      session_id?: string;
      result?: string;
      errors?: string[];
    };
    if (m?.type !== "result") continue;
    const subtype = m.subtype ?? "";
    const outcome: RunResult["outcome"] = /budget/.test(subtype)
      ? "budget"
      : /max_turns|timeout/.test(subtype)
        ? "timeout"
        : m.is_error
          ? "failed"
          : "done";
    return {
      outcome,
      costUsd: typeof m.total_cost_usd === "number" ? m.total_cost_usd : null,
      durationMs: typeof m.duration_ms === "number" ? m.duration_ms : null,
      turns: typeof m.num_turns === "number" ? m.num_turns : null,
      sessionId: m.session_id ?? null,
      detail:
        outcome === "done"
          ? null
          : (m.errors?.join("; ") ?? m.result ?? subtype ?? null),
    };
  }
  return null;
}
