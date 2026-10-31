import { describe, expect, it } from "vitest";

import { createTestDb } from "../test-db";
import type { Actor } from "./actors";
import { issueDirective } from "./directives";
import { Forbidden } from "./errors";
import { addTask, claimTask, listTasks, updateTask } from "./tasks";
import { createUnit } from "./units";

const FOUNDER: Actor = { kind: "human", id: "founder" };
const U = (id: string): Actor => ({ kind: "unit", id });

async function tree() {
  const db = await createTestDb();
  await createUnit(
    { id: "company", name: "Company", summary: "公司" },
    FOUNDER,
    {},
    db,
  );
  await createUnit(
    { id: "eng", parentId: "company", name: "工程", summary: "x" },
    FOUNDER,
    {},
    db,
  );
  await createUnit(
    { id: "mkt", parentId: "company", name: "营销", summary: "x" },
    FOUNDER,
    {},
    db,
  );
  return db;
}

describe("tasks", () => {
  it("lists a unit's open work most urgent first; a claim stands until the task moves", async () => {
    const db = await tree();
    const later = await addTask(
      { unit: "eng", title: "写测试", priority: 2 },
      U("eng"),
      {},
      db,
    );
    const now = await addTask(
      { unit: "eng", title: "修 bug", priority: 0 },
      U("eng"),
      {},
      db,
    );
    await addTask({ unit: "mkt", title: "写帖子" }, U("mkt"), {}, db);
    expect(later.source).toBe("unit:eng");
    expect((await listTasks({ unit: "eng" }, db)).map((t) => t.title)).toEqual([
      "修 bug",
      "写测试",
    ]);

    const claimed = await claimTask({ task: now.id }, U("eng"), {}, db);
    expect([claimed.status, claimed.claimedBy]).toEqual(["doing", "unit:eng"]);
    await expect(claimTask({ task: now.id }, FOUNDER, {}, db)).rejects.toThrow(
      /doing \(unit:eng\)/,
    );
    const done = await updateTask(
      { task: now.id, status: "done", prUrl: "https://github.com/x/y/pull/1" },
      U("eng"),
      {},
      db,
    );
    expect(done.prUrl).toContain("pull/1");
    expect((await listTasks({ unit: "eng" }, db)).map((t) => t.id)).toEqual([
      later.id,
    ]);
    // Another unit's agent can't touch eng's tasks.
    await expect(
      updateTask({ task: later.id, status: "done" }, U("mkt"), {}, db),
    ).rejects.toThrow(Forbidden);
  });

  it("ties a task only to the unit's own directive, and keeps a person's ranking", async () => {
    const db = await tree();
    const d = await issueDirective(
      {
        from: "company",
        to: ["eng"],
        title: "首个付费客户",
        doneWhen: "有人付钱",
      },
      FOUNDER,
      {},
      db,
    );
    await expect(
      addTask({ unit: "mkt", title: "x", directive: d.id }, U("mkt"), {}, db),
    ).rejects.toThrow(/wasn't sent to mkt/);
    const placed = await addTask(
      { unit: "eng", title: "x", directive: d.id, priority: 0 },
      FOUNDER,
      {},
      db,
    );
    expect([placed.pinned, placed.source]).toEqual([true, "human:founder"]);
    await expect(
      updateTask({ task: placed.id, priority: 2 }, U("eng"), {}, db),
    ).rejects.toThrow(/pinned/);
    // The person who placed it may move it.
    expect(
      (await updateTask({ task: placed.id, priority: 1 }, FOUNDER, {}, db))
        .priority,
    ).toBe(1);
    const own = await addTask({ unit: "eng", title: "y" }, U("eng"), {}, db);
    expect(own.pinned).toBe(false);
    await expect(
      addTask({ unit: "eng", title: "x", priority: 5 }, U("eng"), {}, db),
    ).rejects.toThrow(/priority/);
  });
});
