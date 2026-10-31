import { describe, expect, it } from "vitest";

import { createTestDb } from "../test-db";
import {
  ancestors,
  createUnit,
  descendants,
  listUnits,
  personOf,
  TreeError,
  updateUnit,
} from "./units";

describe("units", () => {
  it("grows a tree with no fixed root, owners inherited from above", async () => {
    const db = await createTestDb();
    // A technical founder may start with nothing but engineering.
    await createUnit(
      { id: "engineering", name: "工程", summary: "把产品做出来" },
      db,
    );
    await createUnit(
      {
        id: "frontend",
        parentId: "engineering",
        name: "前端",
        summary: "页面",
      },
      db,
    );
    // Later the company grows above it.
    await createUnit({ id: "company", name: "Company", summary: "公司" }, db);
    await updateUnit(
      "engineering",
      { parentId: "company", owner: null },
      {},
      db,
    );

    const all = await listUnits(db);
    expect(ancestors(all, "frontend").map((u) => u.id)).toEqual([
      "engineering",
      "company",
    ]);
    expect(descendants(all, "company").map((u) => u.id)).toEqual([
      "engineering",
      "frontend",
    ]);
    // A root gets an owner by default; the units below inherit theirs.
    expect(personOf(all, "frontend")).toBe("founder");
    expect(all.find((u) => u.id === "frontend")?.mode).toBe("steer");
  });

  it("refuses bad ids, duplicates, unknown parents and cycles", async () => {
    const db = await createTestDb();
    await createUnit({ id: "company", name: "Company", summary: "公司" }, db);
    await createUnit(
      { id: "eng", parentId: "company", name: "工程", summary: "x" },
      db,
    );
    await expect(
      createUnit({ id: "Eng", name: "x", summary: "x" }, db),
    ).rejects.toThrow(TreeError);
    await expect(
      createUnit({ id: "eng", name: "x", summary: "x" }, db),
    ).rejects.toThrow(/already/);
    await expect(
      createUnit({ id: "ux", parentId: "nope", name: "x", summary: "x" }, db),
    ).rejects.toThrow(/No unit "nope"/);
    await expect(
      updateUnit("company", { parentId: "eng" }, {}, db),
    ).rejects.toThrow(/own subtree/);
  });
});
