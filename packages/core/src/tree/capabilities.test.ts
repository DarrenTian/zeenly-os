import { describe, expect, it } from "vitest";

import { createTestDb } from "../test-db";
import type { Actor } from "./actors";
import {
  grantCapability,
  listCapabilities,
  revokeCapability,
} from "./capabilities";
import { Forbidden } from "./errors";
import { createUnit } from "./units";

const FOUNDER: Actor = { kind: "human", id: "founder" };
const OTHER: Actor = { kind: "human", id: "someone" };

async function tree() {
  const db = await createTestDb();
  await createUnit(
    { id: "company", name: "Company", summary: "The company" },
    FOUNDER,
    {},
    db,
  );
  await createUnit(
    { id: "eng", parentId: "company", name: "Engineering", summary: "x" },
    FOUNDER,
    {},
    db,
  );
  await createUnit(
    { id: "web", parentId: "eng", name: "Frontend", summary: "x" },
    FOUNDER,
    {},
    db,
  );
  return db;
}

describe("capabilities", () => {
  it("flow down the tree as subsets, granted by the parent's person", async () => {
    const db = await tree();
    // A child can't have what its parent doesn't.
    await expect(
      grantCapability({ unit: "eng", tool: "github" }, FOUNDER, {}, db),
    ).rejects.toThrow(/company doesn't have github/);
    await grantCapability({ unit: "company", tool: "github" }, FOUNDER, {}, db);
    await grantCapability(
      { unit: "company", tool: "shell", scope: "/srv/app" },
      FOUNDER,
      {},
      db,
    );
    // The parent's unscoped github covers any scope below.
    const eng = await grantCapability(
      { unit: "eng", tool: "github", scope: "acme/app", level: "parent" },
      FOUNDER,
      {},
      db,
    );
    expect([eng.tool, eng.scope, eng.level]).toEqual([
      "github",
      "acme/app",
      "parent",
    ]);
    // A scoped tool covers only that scope.
    await expect(
      grantCapability(
        { unit: "eng", tool: "shell", scope: "/srv/other" },
        FOUNDER,
        {},
        db,
      ),
    ).rejects.toThrow(/subset of its parent's/);
    await grantCapability(
      { unit: "eng", tool: "shell", scope: "/srv/app" },
      FOUNDER,
      {},
      db,
    );
    await grantCapability(
      { unit: "web", tool: "github", scope: "acme/app", level: "self" },
      FOUNDER,
      {},
      db,
    );
    expect(
      (await listCapabilities("eng", db)).map((c) => [
        c.tool,
        c.scope,
        c.level,
      ]),
    ).toEqual([
      ["github", "acme/app", "parent"],
      ["shell", "/srv/app", "root"],
    ]);
    // Granting again changes the level.
    await grantCapability(
      { unit: "eng", tool: "github", scope: "acme/app", level: "self" },
      FOUNDER,
      {},
      db,
    );
    expect((await listCapabilities("eng", db))[0].level).toBe("self");

    await expect(
      grantCapability({ unit: "eng", tool: "web" }, OTHER, {}, db),
    ).rejects.toThrow(Forbidden);
    await expect(
      grantCapability(
        { unit: "eng", tool: "github" },
        { kind: "unit", id: "eng" },
        {},
        db,
      ),
    ).rejects.toThrow(/Only a person/);
  });

  it("are taken from a unit and everything below it", async () => {
    const db = await tree();
    await grantCapability({ unit: "company", tool: "github" }, FOUNDER, {}, db);
    await grantCapability(
      { unit: "eng", tool: "github", scope: "acme/app" },
      FOUNDER,
      {},
      db,
    );
    await grantCapability(
      { unit: "eng", tool: "github", scope: "acme/site" },
      FOUNDER,
      {},
      db,
    );
    await grantCapability(
      { unit: "web", tool: "github", scope: "acme/site" },
      FOUNDER,
      {},
      db,
    );
    await expect(
      revokeCapability({ unit: "eng", tool: "web" }, FOUNDER, {}, db),
    ).rejects.toThrow(/eng doesn't have web$/);
    const gone = await revokeCapability(
      { unit: "eng", tool: "github", scope: "acme/site" },
      FOUNDER,
      {},
      db,
    );
    expect(gone.removed).toBe(2);
    expect((await listCapabilities("eng", db)).map((c) => c.scope)).toEqual([
      "acme/app",
    ]);
    expect(await listCapabilities("web", db)).toEqual([]);
    // Taking the root's unscoped github takes every github below.
    expect(
      (
        await revokeCapability(
          { unit: "company", tool: "github" },
          FOUNDER,
          {},
          db,
        )
      ).removed,
    ).toBe(2);
    expect(await listCapabilities("eng", db)).toEqual([]);
  });
});
