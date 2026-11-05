import { describe, expect, it } from "vitest";

import { createTestDb } from "../test-db";
import { type Actor, SCHEDULER } from "./actors";
import { decisionDesk } from "./agenda";
import { confirmTranslation, getDirective, issueDirective } from "./directives";
import { getUnitDoc } from "./docs";
import { handleMcp, TREE_TOOLS } from "./mcp";
import { resolveMessage } from "./messages";
import { createUnit } from "./units";

type Db = Awaited<ReturnType<typeof createTestDb>>;

const FOUNDER: Actor = { kind: "human", id: "founder" };
const U = (id: string): Actor => ({ kind: "unit", id });

let nextId = 1;
async function rpc(
  db: Db,
  actor: Actor,
  method: string,
  params?: Record<string, unknown>,
) {
  return handleMcp(
    { jsonrpc: "2.0", id: nextId++, method, params },
    { actor, database: db },
  );
}

/** Calls a tool as `actor`; its JSON result, or throws its error text. */
async function call(
  db: Db,
  actor: Actor,
  name: string,
  args: Record<string, unknown>,
) {
  const reply = (await rpc(db, actor, "tools/call", {
    name,
    arguments: args,
  })) as {
    result: { content: { text: string }[]; isError?: boolean };
  };
  const text = reply.result.content[0].text;
  if (reply.result.isError) throw new Error(text);
  return JSON.parse(text);
}

describe("handleMcp", () => {
  it("speaks enough MCP for a client to connect and list the tools", async () => {
    const db = await createTestDb();
    const init = (await rpc(db, U("x"), "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    })) as { result: { protocolVersion: string; instructions: string } };
    expect(init.result.protocolVersion).toBe("2025-03-26");
    expect(init.result.instructions).toContain("Your token names your unit");
    expect(
      await handleMcp(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { actor: U("x"), database: db },
      ),
    ).toBeNull();

    const list = (await rpc(db, U("x"), "tools/list")) as {
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

    expect(await rpc(db, U("x"), "nope")).toMatchObject({
      error: { code: -32601 },
    });
    await expect(call(db, FOUNDER, "unit_get", {})).rejects.toThrow(/unit/);
    await expect(
      call(db, FOUNDER, "unit_get", { unit: "nope" }),
    ).rejects.toThrow('No unit "nope"');
  });

  it("runs a directive from the person through three units, up to their desk and back", async () => {
    const db = await createTestDb();
    await createUnit(
      { id: "company", name: "Company", summary: "The company" },
      FOUNDER,
      {},
      db,
    );
    for (const id of ["engineering", "marketing", "evaluation"]) {
      await call(db, FOUNDER, "unit_create", {
        id,
        parentId: "company",
        name: id,
        summary: id,
        mode: "autopilot",
      });
    }
    // The person issues it from the root, on the root's page.
    const d = await issueDirective(
      {
        from: "company",
        to: ["engineering", "marketing", "evaluation"],
        title: "First paying customer",
        doneWhen: "A merchant has paid",
      },
      FOUNDER,
      {},
      db,
    );

    // The scheduler asks who has work; each unit's own session runs.
    const pending = await call(db, SCHEDULER, "unit_pending", {});
    expect(pending.map((p: { unit: string }) => p.unit)).toEqual([
      "engineering",
      "evaluation",
      "marketing",
    ]);
    const view = await call(db, U("marketing"), "unit_get", {
      unit: "marketing",
    });
    expect(view.directives[0].directive.title).toBe("First paying customer");
    // A unit's agent sees only its own unit, and acts only as it.
    await expect(
      call(db, U("marketing"), "unit_get", { unit: "engineering" }),
    ).rejects.toThrow(/reads its own unit/);
    await expect(
      call(db, U("marketing"), "directive_translate", {
        directive: d.id,
        unit: "engineering",
        translation: "x",
      }),
    ).rejects.toThrow(/doesn't act for engineering/);
    for (const [unit, translation] of [
      ["engineering", "Trial-to-paid shipped"],
      ["marketing", "Bring 20 trial merchants"],
      ["evaluation", "Prove the paid tier's ranking lift is credible"],
    ]) {
      await call(db, U(unit), "directive_translate", {
        directive: d.id,
        unit,
        translation,
      });
    }
    await call(db, U("engineering"), "task_add", {
      unit: "engineering",
      title: "Add Stripe checkout",
      directive: d.id,
      priority: 0,
    });
    // Marketing wants a free tier; engineering's plan is paid only.
    const up = await call(db, U("marketing"), "message_send", {
      from: "marketing",
      kind: "escalation",
      subject: "Free tier or not",
      body: "Options: a free tier / trial only. I'd pick the free tier",
      directive: d.id,
    });
    expect([up.toUnit, up.forPerson]).toEqual(["company", true]);

    // The person's desk: three translations to confirm and the escalation.
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
          { assignment: item.assignment.id, ok: true },
          FOUNDER,
          {},
          db,
        );
      }
    }
    await resolveMessage(
      { message: up.id, resolution: "Trial only" },
      FOUNDER,
      {},
      db,
    );
    expect(await decisionDesk("founder", db)).toEqual([]);
    // Marketing's guidelines now carry the decision.
    expect(
      (await getUnitDoc({ unit: "marketing", name: "guidelines" }, db))?.body,
    ).toContain("Free tier or not → Trial only");

    // Next run: the units report; marketing reads the answer.
    const next = await call(db, SCHEDULER, "unit_pending", {});
    expect(
      next.find((p: { unit: string }) => p.unit === "marketing").reasons,
    ).toEqual([`read answers to messages ${up.id}, then report`, "report"]);
    const reports: Record<string, number> = {};
    for (const unit of ["engineering", "marketing", "evaluation"]) {
      reports[unit] = (
        await call(db, U(unit), "report_submit", {
          unit,
          directive: d.id,
          status: unit === "engineering" ? "risk" : "ok",
          headline: `${unit} is moving`,
        })
      ).id;
    }
    await expect(
      call(db, U("company"), "report_submit", {
        unit: "company",
        status: "ok",
        headline: "All good",
      }),
    ).rejects.toThrow(/cites a report/);
    await call(db, U("company"), "report_submit", {
      unit: "company",
      status: "risk",
      headline: {
        text: "First paying customer: checkout is at risk",
        cites: [reports.engineering],
      },
    });
    const tree = await call(db, SCHEDULER, "unit_tree", {});
    expect(tree.find((n: { id: string }) => n.id === "company").status).toBe(
      "risk",
    );

    const got = await call(db, FOUNDER, "directive_get", { directive: d.id });
    expect(
      got.assignments.map((a: { translation: string }) => a.translation),
    ).toEqual([
      "Trial-to-paid shipped",
      "Bring 20 trial merchants",
      "Prove the paid tier's ranking lift is credible",
    ]);
    expect(got.reports).toHaveLength(3);

    // Everything above is on marketing's activity stream (the guideline is
    // written inside the resolve, so its event comes first).
    const events = await call(db, U("marketing"), "unit_events", {
      unit: "marketing",
    });
    expect(events.map((e: { what: string }) => e.what)).toEqual([
      "report.submitted",
      "message.resolved",
      "doc.saved",
      "directive.confirmed",
      "message.sent",
      "directive.translated",
      "unit.created",
    ]);

    await call(db, FOUNDER, "directive_close", {
      directive: d.id,
      unit: "company",
      status: "done",
      outcome: "The first merchant paid",
    });
    expect((await getDirective(d.id, db))?.status).toBe("done");
  });
});
