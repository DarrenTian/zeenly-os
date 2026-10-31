import { describe, expect, it } from "vitest";

import { createTestDb } from "../test-db";
import { unitView } from "./agenda";
import {
  DocConflictError,
  getUnitDoc,
  listUnitDocs,
  saveUnitDoc,
} from "./docs";
import { createUnit, deleteUnit, updateUnit } from "./units";

async function tree() {
  const db = await createTestDb();
  await createUnit({ id: "company", name: "Company", summary: "root" }, db);
  await createUnit(
    { id: "marketing", parentId: "company", name: "营销", summary: "x" },
    db,
  );
  return db;
}

describe("a unit's documents", () => {
  it("are versioned: each save on the latest adds one, the same text adds none, a stale base conflicts", async () => {
    const db = await tree();
    expect(await listUnitDocs("marketing", db)).toEqual([]);
    await saveUnitDoc(
      {
        unit: "marketing",
        name: "guidelines",
        body: "一条帖子一种语言",
        baseVersion: 0,
        author: "s",
        reason: "初稿",
      },
      db,
    );
    // The same text again adds nothing.
    expect(
      (
        await saveUnitDoc(
          {
            unit: "marketing",
            name: "guidelines",
            body: "一条帖子一种语言",
            baseVersion: 1,
            author: "s",
            reason: "同",
          },
          db,
        )
      ).version,
    ).toBe(1);
    await saveUnitDoc(
      {
        unit: "marketing",
        name: "guidelines",
        body: "回复亲手写",
        baseVersion: 1,
        author: "founder",
        reason: "加一条",
      },
      db,
    );
    await expect(
      saveUnitDoc(
        {
          unit: "marketing",
          name: "guidelines",
          body: "y",
          baseVersion: 1,
          author: "s",
          reason: "r",
        },
        db,
      ),
    ).rejects.toThrow(DocConflictError);
    await expect(
      saveUnitDoc(
        {
          unit: "marketing",
          name: "guidelines",
          body: "y",
          baseVersion: 1,
          author: "s",
          reason: "r",
        },
        db,
      ),
    ).rejects.toThrow(/version 2 now/);
    expect(
      (
        await getUnitDoc(
          { unit: "marketing", name: "guidelines", version: 1 },
          db,
        )
      )?.body,
    ).toBe("一条帖子一种语言");
    expect(
      (await getUnitDoc({ unit: "marketing", name: "guidelines" }, db))?.body,
    ).toBe("回复亲手写");
    expect(
      (await unitView("marketing", db)).docs.map((d) => [
        d.name,
        d.version,
        d.author,
      ]),
    ).toEqual([["guidelines", 2, "founder"]]);
  });

  it("refuse an empty body, a missing reason or a bad name, and belong to a real unit", async () => {
    const db = await tree();
    const base = { unit: "marketing", baseVersion: 0, author: "s" };
    await expect(
      saveUnitDoc({ ...base, name: "handbook", body: " ", reason: "r" }, db),
    ).rejects.toThrow(/empty/);
    await expect(
      saveUnitDoc({ ...base, name: "handbook", body: "x", reason: " " }, db),
    ).rejects.toThrow(/reason/);
    await expect(
      saveUnitDoc({ ...base, name: "Hand Book", body: "x", reason: "r" }, db),
    ).rejects.toThrow(/name is/);
    await expect(
      saveUnitDoc(
        { ...base, unit: "nope", name: "handbook", body: "x", reason: "r" },
        db,
      ),
    ).rejects.toThrow(/No unit "nope"/);
    expect(await getUnitDoc({ unit: "marketing", name: "handbook" }, db)).toBe(
      null,
    );
  });
});

describe("deleting a unit", () => {
  it("is refused once it has units below it or a history of its own", async () => {
    const db = await tree();
    await expect(deleteUnit("company", db)).rejects.toThrow(
      /Move the units under/,
    );
    await saveUnitDoc(
      {
        unit: "marketing",
        name: "notes",
        body: "x",
        baseVersion: 0,
        author: "s",
        reason: "r",
      },
      db,
    );
    await updateUnit("marketing", { parentId: null }, {}, db);
    await expect(deleteUnit("marketing", db)).rejects.toThrow(/has a history/);
    await deleteUnit("company", db);
  });
});
