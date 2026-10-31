import { describe, expect, it } from "vitest";

import { createTestDb } from "../test-db";
import {
  closeDirective,
  confirmTranslation,
  directiveChain,
  getDirective,
  issueDirective,
  translateDirective,
} from "./directives";
import { addTask, listTasks } from "./tasks";
import { createUnit } from "./units";

async function tree() {
  const db = await createTestDb();
  await createUnit({ id: "company", name: "Company", summary: "公司" }, db);
  for (const id of ["eng", "mkt", "eval"]) {
    await createUnit(
      { id, parentId: "company", name: id, summary: id, mode: "autopilot" },
      db,
    );
  }
  await createUnit(
    {
      id: "seo",
      parentId: "mkt",
      name: "SEO",
      summary: "x",
      mode: "autopilot",
    },
    db,
  );
  return db;
}

const GOAL = {
  from: "company",
  to: ["eng", "mkt", "eval"],
  title: "首个付费客户",
  doneWhen: "一个商家付了钱",
  dueOn: "2026-11-08",
  by: "founder",
};

describe("directives", () => {
  it("goes down as a directive, sideways as a request", async () => {
    const db = await tree();
    const down = await issueDirective(GOAL, db);
    expect(down.assignments.map((a) => [a.unitId, a.kind, a.state])).toEqual([
      ["eng", "directive", "new"],
      ["mkt", "directive", "new"],
      ["eval", "directive", "new"],
    ]);
    const side = await issueDirective(
      {
        from: "eng",
        to: ["mkt", "seo"],
        title: "写上线说明",
        doneWhen: "发出去",
        by: "s",
      },
      db,
    );
    expect(side.assignments.map((a) => a.kind)).toEqual(["request", "request"]);
  });

  it("waits on the root's person for its first layer's translations", async () => {
    const db = await tree();
    const d = await issueDirective(GOAL, db);
    expect(d.assignments.every((a) => a.needsConfirm)).toBe(true);

    const proposed = await translateDirective(
      { directive: d.id, unit: "eng", translation: "两周内上线付费墙" },
      {},
      db,
    );
    expect(proposed.state).toBe("proposed");
    // Sent back: the unit translates again, reading the note.
    const back = await confirmTranslation(
      {
        assignment: proposed.id,
        ok: false,
        note: "先做试用转付费",
        person: "founder",
      },
      {},
      db,
    );
    expect([back.state, back.note]).toEqual(["new", "先做试用转付费"]);
    await translateDirective(
      { directive: d.id, unit: "eng", translation: "上线试用转付费" },
      {},
      db,
    );
    const ok = await confirmTranslation(
      { assignment: proposed.id, ok: true, person: "founder" },
      {},
      db,
    );
    expect([ok.state, ok.translation, ok.note]).toEqual([
      "active",
      "上线试用转付费",
      null,
    ]);
    await expect(
      confirmTranslation(
        { assignment: proposed.id, ok: true, person: "founder" },
        {},
        db,
      ),
    ).rejects.toThrow(/isn't waiting/);

    // Deeper down, translations take effect without the founder.
    const passed = await issueDirective(
      { ...GOAL, from: "mkt", to: ["seo"], parentId: d.id, by: "s" },
      db,
    );
    expect(passed.assignments[0].needsConfirm).toBe(false);
    const seo = await translateDirective(
      {
        directive: passed.id,
        unit: "seo",
        translation: "排行榜页面带试用入口",
      },
      {},
      db,
    );
    expect(seo.state).toBe("active");
  });

  it("lets a unit say a directive isn't its own, with why", async () => {
    const db = await tree();
    const d = await issueDirective(GOAL, db);
    await expect(
      translateDirective(
        { directive: d.id, unit: "eval", relevant: false },
        {},
        db,
      ),
    ).rejects.toThrow(/why/);
    const no = await translateDirective(
      {
        directive: d.id,
        unit: "eval",
        relevant: false,
        reason: "评测不碰收费",
      },
      {},
      db,
    );
    expect([no.state, no.note]).toEqual(["declined", "评测不碰收费"]);
    await expect(
      translateDirective(
        { directive: d.id, unit: "seo", translation: "x" },
        {},
        db,
      ),
    ).rejects.toThrow(/wasn't sent to seo/);
  });

  it("passes on only what the unit was sent", async () => {
    const db = await tree();
    const d = await issueDirective(GOAL, db);
    await expect(
      issueDirective({ ...GOAL, from: "seo", to: ["eng"], parentId: d.id }, db),
    ).rejects.toThrow(/only pass on/);
    await expect(issueDirective({ ...GOAL, to: [] }, db)).rejects.toThrow(
      /at least one/,
    );
    await expect(
      issueDirective({ ...GOAL, dueOn: "next week" }, db),
    ).rejects.toThrow(/YYYY-MM-DD/);
  });

  it("is closed by its issuer only, taking its passed-on directives and unstarted tasks with it", async () => {
    const db = await tree();
    const d = await issueDirective(GOAL, db);
    const passed = await issueDirective(
      { ...GOAL, from: "mkt", to: ["seo"], parentId: d.id, by: "s" },
      db,
    );
    await addTask(
      { unit: "seo", title: "x", directive: passed.id, source: "s" },
      db,
    );
    expect((await directiveChain(d.id, db)).map((c) => c.id)).toEqual([
      passed.id,
    ]);

    await expect(
      closeDirective(
        { directive: d.id, unit: "mkt", status: "done", outcome: "x" },
        {},
        db,
      ),
    ).rejects.toThrow(/Only company/);
    const closed = await closeDirective(
      {
        directive: d.id,
        unit: "company",
        status: "done",
        outcome: "第一个商家付了 $49",
      },
      {},
      db,
    );
    expect(closed.status).toBe("done");
    expect(closed.assignments.every((a) => a.state === "closed")).toBe(true);
    const child = (await getDirective(passed.id, db))!;
    expect([child.status, child.outcome]).toEqual([
      "done",
      `随指令 ${d.id} 结束：第一个商家付了 $49`,
    ]);
    expect(await listTasks({ unit: "seo" }, db)).toEqual([]);
    await expect(
      translateDirective(
        { directive: d.id, unit: "eng", translation: "x" },
        {},
        db,
      ),
    ).rejects.toThrow(/closed/);
  });
});
