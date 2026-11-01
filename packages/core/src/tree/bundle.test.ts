import { describe, expect, it } from "vitest";

import { createTestDb } from "../test-db";
import type { Actor } from "./actors";
import {
  BUNDLE_FORMAT,
  bundleCounts,
  exportCompany,
  importCompany,
  type CompanyBundle,
} from "./bundle";
import { getDirective, issueDirective, translateDirective } from "./directives";
import { saveUnitDoc } from "./docs";
import { listEvents } from "./events";
import { sendMessage } from "./messages";
import { latestReports, submitReport } from "./reports";
import { addTask, listTasks } from "./tasks";
import { issueToken } from "./tokens";
import { createUnit, listUnits } from "./units";

const FOUNDER: Actor = { kind: "human", id: "founder" };
const U = (id: string): Actor => ({ kind: "unit", id });
const IMPORT: Actor = { kind: "system", id: "import" };
const T0 = new Date("2026-11-01T09:00:00Z");

/** Two companies in one database: `acme` (with eng) and `other`, plus some of everything. */
async function source() {
  const db = await createTestDb();
  const unit = (id: string, parentId?: string) =>
    createUnit(
      { id, parentId, name: id, summary: id },
      FOUNDER,
      { now: T0 },
      db,
    );
  await unit("other");
  await unit("ops", "other");
  await unit("acme");
  await unit("eng", "acme");
  // An id taken by the other company first, so acme's don't start at 1.
  await issueDirective(
    { from: "other", to: ["ops"], title: "theirs", doneWhen: "x" },
    FOUNDER,
    { now: T0 },
    db,
  );
  const d = await issueDirective(
    { from: "acme", to: ["eng"], title: "ship it", doneWhen: "shipped" },
    FOUNDER,
    { now: T0 },
    db,
  );
  await translateDirective(
    { directive: d.id, unit: "eng", translation: "build it" },
    U("eng"),
    { now: T0 },
    db,
  );
  await addTask(
    { unit: "eng", title: "write it", directive: d.id },
    U("eng"),
    { now: T0 },
    db,
  );
  await saveUnitDoc(
    {
      unit: "eng",
      name: "handbook",
      body: "how",
      baseVersion: 0,
      reason: "first",
    },
    U("eng"),
    { now: T0 },
    db,
  );
  await sendMessage(
    { from: "eng", kind: "escalation", subject: "which way?", directive: d.id },
    U("eng"),
    { now: T0 },
    db,
  );
  const r = await submitReport(
    {
      unit: "eng",
      directive: d.id,
      status: "ok",
      headline: { text: "on track" },
    },
    U("eng"),
    { now: T0 },
    db,
  );
  await submitReport(
    { unit: "acme", status: "ok", headline: { text: "fine", cites: [r.id] } },
    FOUNDER,
    { now: T0 },
    db,
  );
  await issueToken({ actor: FOUNDER, label: "mine" }, FOUNDER, { now: T0 }, db);
  return { db, directive: d.id };
}

// Each test builds two databases and a company in one; slow machines need more than the default.
describe("company bundles", { timeout: 30_000 }, () => {
  it("hold the root, everything below it and what's theirs, and nothing of another company's", async () => {
    const { db, directive } = await source();
    const bundle = await exportCompany("acme", db, T0);
    expect(bundle.format).toBe(BUNDLE_FORMAT);
    expect(bundle.units.map((u) => u.id).sort()).toEqual(["acme", "eng"]);
    expect(bundle.directives.map((d) => d.id)).toEqual([directive]);
    expect(bundleCounts(bundle)).toMatchObject({
      directives: 1,
      assignments: 1,
      tasks: 1,
      messages: 1,
      reports: 2,
    });
    expect(bundle.docs.some((d) => d.name === "handbook")).toBe(true);
    expect(
      bundle.events.every((e) => e.unitId === "acme" || e.unitId === "eng"),
    ).toBe(true);
    expect(bundle.events.some((e) => e.onKind === "token")).toBe(false);
  });

  it("load into an empty database as they were, ids and citations included", async () => {
    const { db, directive } = await source();
    const bundle = await exportCompany("acme", db, T0);
    const target = await createTestDb();
    // Through JSON, as the file goes.
    const counts = await importCompany(
      JSON.parse(JSON.stringify(bundle)),
      IMPORT,
      target,
      T0,
    );
    expect(counts).toEqual(bundleCounts(bundle));

    expect((await listUnits(target)).map((u) => u.id).sort()).toEqual([
      "acme",
      "eng",
    ]);
    expect((await getDirective(directive, target))?.title).toBe("ship it");
    const latest = await latestReports(target);
    expect(latest.get("acme")?.headline.cites).toEqual([latest.get("eng")?.id]);

    // New rows follow the kept ids instead of colliding with them.
    const next = await issueDirective(
      { from: "acme", to: ["eng"], title: "next", doneWhen: "x" },
      FOUNDER,
      { now: T0 },
      target,
    );
    expect(next.id).toBe(directive + 1);
    const [kept] = await listTasks({ unit: "eng" }, target);
    const task = await addTask(
      { unit: "eng", title: "more" },
      U("eng"),
      { now: T0 },
      target,
    );
    expect(task.id).toBe(kept.id + 1);

    const whats = (await listEvents({ limit: 500 }, target)).map((e) => e.what);
    expect(whats).toContain("company.imported");
    expect(whats.filter((w) => w === "unit.imported")).toHaveLength(2);
  });

  it("export again the same as they were imported", async () => {
    const { db } = await source();
    const bundle = await exportCompany("acme", db, T0);
    const target = await createTestDb();
    await importCompany(bundle, IMPORT, target, T0);
    const again = await exportCompany("acme", target, T0);
    const strip = (b: CompanyBundle) => ({ ...b, events: [] });
    expect(strip(again)).toEqual(strip(bundle));
  });

  it("make a subtree exported on its own a company of its own", async () => {
    const { db } = await source();
    const bundle = await exportCompany("eng", db, T0);
    expect(bundle.units.map((u) => [u.id, u.parentId])).toEqual([
      ["eng", null],
    ]);
    // acme's directive and report stay behind; eng's task loses its directive.
    expect(bundle.directives).toEqual([]);
    expect(bundle.tasks[0].directiveId).toBeNull();
    const target = await createTestDb();
    await importCompany(bundle, IMPORT, target, T0);
    expect((await listUnits(target)).map((u) => u.id)).toEqual(["eng"]);
  });

  it("go only into a database without a company", async () => {
    const { db } = await source();
    const bundle = await exportCompany("acme", db, T0);
    await expect(importCompany(bundle, IMPORT, db, T0)).rejects.toThrow(
      /empty/,
    );
  });

  it("are refused, whole, when they aren't one or point at what they don't hold", async () => {
    const target = await createTestDb();
    await expect(
      importCompany({ format: "x" }, IMPORT, target, T0),
    ).rejects.toThrow(/Not a zeenly-os.company\/1 file/);
    const { db } = await source();
    const bundle = await exportCompany("acme", db, T0);
    const broken = {
      ...bundle,
      tasks: bundle.tasks.map((t) => ({ ...t, unitId: "ghost" })),
    };
    await expect(importCompany(broken, IMPORT, target, T0)).rejects.toThrow(
      /no unit ghost/,
    );
    expect(await listUnits(target)).toEqual([]);
  });
});
