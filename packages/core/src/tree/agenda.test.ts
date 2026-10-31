import { describe, expect, it } from "vitest";

import { createTestDb } from "../test-db";
import { decisionDesk, pendingUnits, treeOverview, unitView } from "./agenda";
import {
  confirmTranslation,
  issueDirective,
  translateDirective,
} from "./directives";
import { resolveMessage, sendMessage } from "./messages";
import { submitReport } from "./reports";
import { createUnit } from "./units";

async function tree() {
  const db = await createTestDb();
  await createUnit(
    { id: "company", name: "Company", summary: "公司", charter: "全公司" },
    db,
  );
  for (const [id, name] of [
    ["eng", "工程"],
    ["mkt", "营销"],
    ["eval", "评测"],
  ]) {
    await createUnit(
      {
        id,
        parentId: "company",
        name,
        summary: `${name}的事`,
        mode: "autopilot",
      },
      db,
    );
  }
  await createUnit(
    {
      id: "seo",
      parentId: "mkt",
      name: "SEO",
      summary: "搜索",
      mode: "autopilot",
    },
    db,
  );
  await createUnit({ id: "elsewhere", name: "别的公司", summary: "x" }, db);
  return db;
}

const T0 = new Date("2026-10-25T10:00:00Z");
const hours = (n: number) => new Date(T0.getTime() + n * 3600_000);

describe("pendingUnits", () => {
  it("wakes only units with something to do, deepest first, and lets the rest sleep", async () => {
    const db = await tree();
    expect(await pendingUnits({ now: T0 }, db)).toEqual([]);

    const d = await issueDirective(
      {
        from: "company",
        to: ["eng", "mkt"],
        title: "首个付费客户",
        doneWhen: "有人付钱",
        by: "founder",
      },
      db,
    );
    await sendMessage(
      { from: "eng", kind: "request", to: "seo", subject: "x", by: "s" },
      db,
    );
    expect(await pendingUnits({ now: T0 }, db)).toEqual([
      {
        unit: "seo",
        depth: 2,
        reasons: [expect.stringMatching(/answer messages/)],
      },
      { unit: "eng", depth: 1, reasons: [`translate directive ${d.id}`] },
      { unit: "mkt", depth: 1, reasons: [`translate directive ${d.id}`] },
    ]);

    // Translated and confirmed: due a report; reported: asleep for a day.
    const part = await translateDirective(
      { directive: d.id, unit: "eng", translation: "上线付费" },
      { now: T0 },
      db,
    );
    await confirmTranslation(
      { assignment: part.id, ok: true, person: "founder" },
      {},
      db,
    );
    expect(
      (await pendingUnits({ now: T0 }, db)).find((p) => p.unit === "eng")
        ?.reasons,
    ).toEqual(["report"]);
    await submitReport(
      { unit: "eng", status: "ok", headline: "x", by: "s" },
      { now: T0 },
      db,
    );
    expect(
      (await pendingUnits({ now: hours(1) }, db)).some((p) => p.unit === "eng"),
    ).toBe(false);
    expect(
      (await pendingUnits({ now: hours(25) }, db)).find((p) => p.unit === "eng")
        ?.reasons,
    ).toEqual(["report"]);
  });

  it("wakes a sender when its message is answered, and an active parent when a child reports", async () => {
    const db = await tree();
    const d = await issueDirective(
      {
        from: "company",
        to: ["mkt"],
        title: "x",
        doneWhen: "y",
        by: "founder",
      },
      db,
    );
    const part = await translateDirective(
      { directive: d.id, unit: "mkt", translation: "z" },
      {},
      db,
    );
    await confirmTranslation(
      { assignment: part.id, ok: true, person: "founder" },
      {},
      db,
    );
    await submitReport(
      { unit: "mkt", status: "ok", headline: "x", by: "s" },
      { now: T0 },
      db,
    );

    const m = await sendMessage(
      { from: "mkt", kind: "escalation", subject: "x", by: "s" },
      db,
    );
    await resolveMessage(
      { message: m.id, person: "founder", resolution: "做", by: "founder" },
      { now: hours(1) },
      db,
    );
    await submitReport(
      { unit: "seo", status: "risk", headline: "x", by: "s" },
      { now: hours(1) },
      db,
    );
    expect(
      (await pendingUnits({ now: hours(2) }, db)).find((p) => p.unit === "mkt")
        ?.reasons,
    ).toEqual([
      `read answers to messages ${m.id}, then report`,
      "report: children reported since",
    ]);
  });
});

describe("unitView", () => {
  it("shows a unit itself and its children in full, its ancestors' charters, others' summaries", async () => {
    const db = await tree();
    const d = await issueDirective(
      {
        from: "company",
        to: ["mkt"],
        title: "首个付费客户",
        doneWhen: "有人付钱",
        by: "founder",
      },
      db,
    );
    const view = await unitView("mkt", db);
    expect(view.person).toBe("founder");
    expect(view.ancestors.map((a) => [a.id, a.charter])).toEqual([
      ["company", "全公司"],
    ]);
    expect(view.peers.map((p) => p.id).sort()).toEqual(["eng", "eval"]);
    expect(view.children.map((c) => c.id)).toEqual(["seo"]);
    expect(
      view.directives.map((p) => [p.directive.id, p.assignment.state]),
    ).toEqual([[d.id, "new"]]);
    expect(view.directives[0].directive).not.toHaveProperty("assignments");
    // Of its ancestors' directives, seo sees those they were sent: mkt's,
    // not the one the root issued.
    const seo = await unitView("seo", db);
    expect(
      seo.ancestors.map((a) => [a.id, a.openDirectives.map((o) => o.id)]),
    ).toEqual([
      ["mkt", [d.id]],
      ["company", []],
    ]);
    expect(seo.peers.map((p) => p.id).sort()).toEqual(["eng", "eval"]);
  });
});

describe("decisionDesk", () => {
  it("holds what climbed to the founder and the translations they confirm", async () => {
    const db = await tree();
    const d = await issueDirective(
      {
        from: "company",
        to: ["eng", "mkt"],
        title: "首个付费客户",
        doneWhen: "有人付钱",
        by: "founder",
      },
      db,
    );
    await translateDirective(
      { directive: d.id, unit: "eng", translation: "上线付费" },
      {},
      db,
    );
    const up = await sendMessage(
      { from: "mkt", kind: "escalation", subject: "降价？", by: "s" },
      db,
    );
    // Someone else's tree isn't on the founder's desk.
    await createUnit(
      { id: "acme", name: "Acme", summary: "x", owner: "someone" },
      db,
    );
    await sendMessage(
      { from: "acme", kind: "escalation", subject: "x", by: "s" },
      db,
    );

    const desk = await decisionDesk("founder", db);
    expect(
      desk.map((i) =>
        i.kind === "confirm" ? ["confirm", i.unitName] : [i.kind, i.message.id],
      ),
    ).toEqual([
      ["escalation", up.id],
      ["confirm", "工程"],
    ]);
    expect((await decisionDesk("someone", db)).length).toBe(1);
  });
});

describe("treeOverview", () => {
  it("lists each unit after its parent with its rolled-up colour", async () => {
    const db = await tree();
    await submitReport(
      { unit: "seo", status: "stuck", headline: "x", blocked: ["y"], by: "s" },
      { now: T0 },
      db,
    );
    const nodes = await treeOverview(db);
    expect(nodes.map((n) => [n.unit.id, n.depth, n.status])).toEqual([
      ["company", 0, "stuck"],
      ["eng", 1, null],
      ["mkt", 1, "stuck"],
      ["seo", 2, "stuck"],
      ["eval", 1, null],
      ["elsewhere", 0, null],
    ]);
  });
});
