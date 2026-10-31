import { describe, expect, it } from "vitest";

import { createTestDb } from "../test-db";
import { issueDirective } from "./directives";
import { addTask, claimTask, listTasks, updateTask } from "./tasks";
import { createUnit } from "./units";

async function tree() {
  const db = await createTestDb();
  await createUnit({ id: "company", name: "Company", summary: "公司" }, db);
  await createUnit(
    { id: "eng", parentId: "company", name: "工程", summary: "x" },
    db,
  );
  await createUnit(
    { id: "mkt", parentId: "company", name: "营销", summary: "x" },
    db,
  );
  return db;
}

describe("tasks", () => {
  it("lists a unit's open work most urgent first; a claim is one session's", async () => {
    const db = await tree();
    const later = await addTask(
      { unit: "eng", title: "写测试", priority: 2, source: "s1" },
      db,
    );
    const now = await addTask(
      { unit: "eng", title: "修 bug", priority: 0, source: "s1" },
      db,
    );
    await addTask({ unit: "mkt", title: "写帖子", source: "s1" }, db);
    expect((await listTasks({ unit: "eng" }, db)).map((t) => t.title)).toEqual([
      "修 bug",
      "写测试",
    ]);

    const claimed = await claimTask({ task: now.id, by: "session-a" }, {}, db);
    expect([claimed.status, claimed.claimedBy]).toEqual(["doing", "session-a"]);
    await expect(
      claimTask({ task: now.id, by: "session-b" }, {}, db),
    ).rejects.toThrow(/doing \(session-a\)/);
    const done = await updateTask(
      { task: now.id, status: "done", prUrl: "https://github.com/x/y/pull/1" },
      {},
      db,
    );
    expect(done.prUrl).toContain("pull/1");
    expect((await listTasks({ unit: "eng" }, db)).map((t) => t.id)).toEqual([
      later.id,
    ]);
  });

  it("ties a task only to the unit's own directive, and keeps a pinned task's ranking", async () => {
    const db = await tree();
    const d = await issueDirective(
      {
        from: "company",
        to: ["eng"],
        title: "首个付费客户",
        doneWhen: "有人付钱",
        by: "founder",
      },
      db,
    );
    await expect(
      addTask({ unit: "mkt", title: "x", directive: d.id, source: "s" }, db),
    ).rejects.toThrow(/wasn't sent to mkt/);
    const placed = await addTask(
      {
        unit: "eng",
        title: "x",
        directive: d.id,
        source: "founder",
        pinned: true,
        priority: 0,
      },
      db,
    );
    await expect(
      updateTask({ task: placed.id, priority: 2 }, {}, db),
    ).rejects.toThrow(/pinned/);
    await expect(
      addTask({ unit: "eng", title: "x", priority: 5, source: "s" }, db),
    ).rejects.toThrow(/priority/);
  });
});
