import { describe, expect, it } from "vitest";

import { createTestDb } from "../test-db";
import { decisionDesk } from "./agenda";
import { confirmTranslation, getDirective, issueDirective } from "./directives";
import { handleMcp, TREE_TOOLS } from "./mcp";
import { resolveMessage } from "./messages";
import { createUnit } from "./units";

type Db = Awaited<ReturnType<typeof createTestDb>>;

let nextId = 1;
async function rpc(db: Db, method: string, params?: Record<string, unknown>) {
  return handleMcp(
    { jsonrpc: "2.0", id: nextId++, method, params },
    { database: db },
  );
}

/** Calls a tool; its JSON result, or throws its error text. */
async function call(db: Db, name: string, args: Record<string, unknown>) {
  const reply = (await rpc(db, "tools/call", { name, arguments: args })) as {
    result: { content: { text: string }[]; isError?: boolean };
  };
  const text = reply.result.content[0].text;
  if (reply.result.isError) throw new Error(text);
  return JSON.parse(text);
}

describe("handleMcp", () => {
  it("speaks enough MCP for a client to connect and list the tools", async () => {
    const db = await createTestDb();
    const init = (await rpc(db, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    })) as { result: { protocolVersion: string; instructions: string } };
    expect(init.result.protocolVersion).toBe("2025-03-26");
    expect(init.result.instructions).toContain("unit_pending");
    expect(
      await handleMcp(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { database: db },
      ),
    ).toBeNull();

    const list = (await rpc(db, "tools/list")) as {
      result: { tools: { name: string; inputSchema: { type: string } }[] };
    };
    expect(list.result.tools.map((t) => t.name)).toEqual(
      TREE_TOOLS.map((t) => t.name),
    );
    // Claude's API takes only letters, digits, _ and - in tool names.
    expect(
      list.result.tools.every((t) => /^[a-zA-Z0-9_-]+$/.test(t.name)),
    ).toBe(true);
    expect(
      list.result.tools.every((t) => t.inputSchema.type === "object"),
    ).toBe(true);

    expect(await rpc(db, "nope")).toMatchObject({ error: { code: -32601 } });
    await expect(call(db, "unit_get", {})).rejects.toThrow(/unit/);
    await expect(call(db, "unit_get", { unit: "nope" })).rejects.toThrow(
      'No unit "nope"',
    );
  });

  it("runs a directive from the founder through three units, up to the founder's desk and back", async () => {
    const db = await createTestDb();
    await createUnit({ id: "company", name: "Company", summary: "公司" }, db);
    for (const id of ["engineering", "marketing", "evaluation"]) {
      await call(db, "unit_create", {
        id,
        parentId: "company",
        name: id,
        summary: id,
        mode: "autopilot",
      });
    }
    // The founder issues it from the root, on the root's page.
    const d = await issueDirective(
      {
        from: "company",
        to: ["engineering", "marketing", "evaluation"],
        title: "首个付费客户",
        doneWhen: "一个商家付了钱",
        by: "founder",
      },
      db,
    );

    // The hourly session: what's pending, then each unit in turn.
    const pending = await call(db, "unit_pending", {});
    expect(pending.map((p: { unit: string }) => p.unit)).toEqual([
      "engineering",
      "evaluation",
      "marketing",
    ]);
    const view = await call(db, "unit_get", { unit: "marketing" });
    expect(view.directives[0].directive.title).toBe("首个付费客户");
    for (const [unit, translation] of [
      ["engineering", "试用转付费上线"],
      ["marketing", "带来 20 个试用商家"],
      ["evaluation", "证明付费版的排名提升可信"],
    ]) {
      await call(db, "directive_translate", {
        directive: d.id,
        unit,
        translation,
      });
    }
    await call(db, "task_add", {
      unit: "engineering",
      title: "加 Stripe 结账",
      directive: d.id,
      priority: 0,
      source: "hourly",
    });
    // Marketing wants a free tier; engineering's plan is paid only.
    const up = await call(db, "message_send", {
      from: "marketing",
      kind: "escalation",
      subject: "要不要免费档",
      body: "选项：有免费档 / 只有试用。我选免费档",
      directive: d.id,
      by: "hourly",
    });
    expect([up.toUnit, up.forPerson]).toEqual(["company", true]);

    // The founder's desk: three translations to confirm and the escalation.
    const desk = await decisionDesk("founder", db);
    expect(desk.map((i) => i.kind)).toEqual([
      "escalation",
      "confirm",
      "confirm",
      "confirm",
    ]);
    for (const item of desk) {
      if (item.kind === "confirm") {
        await confirmTranslation(
          { assignment: item.assignment.id, ok: true, person: "founder" },
          {},
          db,
        );
      }
    }
    await resolveMessage(
      {
        message: up.id,
        person: "founder",
        resolution: "只有试用",
        by: "founder",
      },
      {},
      db,
    );
    expect(await decisionDesk("founder", db)).toEqual([]);

    // Next hour: the units report; marketing reads the answer.
    const next = await call(db, "unit_pending", {});
    expect(
      next.find((p: { unit: string }) => p.unit === "marketing").reasons,
    ).toEqual([`read answers to messages ${up.id}, then report`, "report"]);
    const reports: Record<string, number> = {};
    for (const unit of ["engineering", "marketing", "evaluation"]) {
      reports[unit] = (
        await call(db, "report_submit", {
          unit,
          directive: d.id,
          status: unit === "engineering" ? "risk" : "ok",
          headline: `${unit} 在推进`,
          by: "hourly",
        })
      ).id;
    }
    await expect(
      call(db, "report_submit", {
        unit: "company",
        status: "ok",
        headline: "都好",
        by: "hourly",
      }),
    ).rejects.toThrow(/cites a report/);
    await call(db, "report_submit", {
      unit: "company",
      status: "risk",
      headline: {
        text: "首个付费客户：结账有风险",
        cites: [reports.engineering],
      },
      by: "hourly",
    });
    const tree = await call(db, "unit_tree", {});
    expect(tree.find((n: { id: string }) => n.id === "company").status).toBe(
      "risk",
    );

    const got = await call(db, "directive_get", { directive: d.id });
    expect(
      got.assignments.map((a: { translation: string }) => a.translation),
    ).toEqual([
      "试用转付费上线",
      "带来 20 个试用商家",
      "证明付费版的排名提升可信",
    ]);
    expect(got.reports).toHaveLength(3);

    await call(db, "directive_close", {
      directive: d.id,
      unit: "company",
      status: "done",
      outcome: "第一个商家付了钱",
    });
    expect((await getDirective(d.id, db))?.status).toBe("done");
  });
});
