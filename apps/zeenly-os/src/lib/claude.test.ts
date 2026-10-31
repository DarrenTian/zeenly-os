import type { Capability } from "@zeenly-os/core";
import { describe, expect, it } from "vitest";

import { mcpConfig, prompt, readResult, toolFlags } from "./claude";

const cap = (tool: string, scope = ""): Capability => ({
  id: 1,
  unitId: "eng",
  tool,
  scope,
  level: "root",
  approvals: 0,
  createdAt: new Date(0),
});

describe("toolFlags", () => {
  it("gives a unit with no capabilities only the tree", () => {
    expect(toolFlags([])).toEqual({ tools: [], allowed: ["mcp__zeenly"] });
  });

  it("turns capabilities into built-in tools and rules, scopes narrowing the rules", () => {
    const flags = toolFlags([
      cap("shell"),
      cap("files", "/srv/app/"),
      cap("web", "docs.example.com"),
      cap("github", "pr"),
      cap("unknown-tool"),
    ]);
    expect(flags.tools).toEqual([
      "Bash",
      "Read",
      "Edit",
      "Write",
      "Glob",
      "Grep",
      "WebFetch",
      "WebSearch",
    ]);
    expect(flags.allowed).toEqual([
      "mcp__zeenly",
      "Bash",
      "Read(/srv/app/**)",
      "Edit(/srv/app/**)",
      "Write(/srv/app/**)",
      "Glob(/srv/app/**)",
      "Grep(/srv/app/**)",
      "WebFetch(domain:docs.example.com)",
      "WebSearch",
      "Bash(gh pr:*)",
    ]);
  });
});

describe("the session's config", () => {
  it("points the tree's server at this install with the unit's token", () => {
    expect(JSON.parse(mcpConfig("http://localhost:3000/", "zos_abc"))).toEqual({
      mcpServers: {
        zeenly: {
          type: "http",
          url: "http://localhost:3000/api/mcp",
          headers: { Authorization: "Bearer zos_abc" },
        },
      },
    });
    expect(prompt("eng")).toContain('unit "eng"');
  });
});

describe("readResult", () => {
  it("reads cost, turns and how it ended from the final result line", () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
      JSON.stringify({ type: "assistant", message: {} }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        total_cost_usd: 0.1234,
        duration_ms: 42_000,
        num_turns: 7,
        session_id: "s1",
        result: "done",
      }),
    ];
    expect(readResult(lines)).toEqual({
      outcome: "done",
      costUsd: 0.1234,
      durationMs: 42_000,
      turns: 7,
      sessionId: "s1",
      detail: null,
    });
    expect(
      readResult([
        JSON.stringify({
          type: "result",
          subtype: "error_max_budget_usd",
          is_error: true,
          total_cost_usd: 2,
          num_turns: 30,
        }),
      ]),
    ).toMatchObject({
      outcome: "budget",
      costUsd: 2,
      detail: "error_max_budget_usd",
    });
    expect(
      readResult([
        JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["MCP server zeenly failed to connect"],
        }),
      ]),
    ).toMatchObject({
      outcome: "failed",
      detail: "MCP server zeenly failed to connect",
    });
    expect(readResult(["not json", ""])).toBeNull();
  });
});
