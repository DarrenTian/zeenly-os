import { describe, expect, it } from "vitest";

import { createTestDb } from "../test-db";
import type { Actor } from "./actors";
import {
  closeDirective,
  confirmTranslation,
  directiveChain,
  getDirective,
  issueDirective,
  translateDirective,
} from "./directives";
import { getUnitDoc } from "./docs";
import { Forbidden } from "./errors";
import { addTask, listTasks } from "./tasks";
import { createUnit } from "./units";

const FOUNDER: Actor = { kind: "human", id: "founder" };
const U = (id: string): Actor => ({ kind: "unit", id });

async function tree() {
  const db = await createTestDb();
  await createUnit(
    { id: "company", name: "Company", summary: "The company" },
    FOUNDER,
    {},
    db,
  );
  for (const id of ["eng", "mkt", "eval"]) {
    await createUnit(
      { id, parentId: "company", name: id, summary: id, mode: "autopilot" },
      FOUNDER,
      {},
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
    FOUNDER,
    {},
    db,
  );
  return db;
}

const GOAL = {
  from: "company",
  to: ["eng", "mkt", "eval"],
  title: "First paying customer",
  doneWhen: "A merchant has paid",
  dueOn: "2026-11-08",
};

describe("directives", () => {
  it("goes down as a directive, sideways as a request", async () => {
    const db = await tree();
    const down = await issueDirective(GOAL, FOUNDER, {}, db);
    expect(down.assignments.map((a) => [a.unitId, a.kind, a.state])).toEqual([
      ["eng", "directive", "new"],
      ["mkt", "directive", "new"],
      ["eval", "directive", "new"],
    ]);
    expect(down.createdBy).toBe("human:founder");
    const side = await issueDirective(
      {
        from: "eng",
        to: ["mkt", "seo"],
        title: "Write the launch notes",
        doneWhen: "It is sent",
      },
      U("eng"),
      {},
      db,
    );
    expect(side.assignments.map((a) => a.kind)).toEqual(["request", "request"]);
    // A unit's agent issues only from its own unit.
    await expect(
      issueDirective({ ...GOAL, from: "mkt" }, U("eng"), {}, db),
    ).rejects.toThrow(Forbidden);
  });

  it("waits on the root's person for its first layer's translations, and a send-back becomes a guideline", async () => {
    const db = await tree();
    const d = await issueDirective(GOAL, FOUNDER, {}, db);
    expect(d.assignments.every((a) => a.needsConfirm)).toBe(true);

    const proposed = await translateDirective(
      {
        directive: d.id,
        unit: "eng",
        translation: "Ship the paywall within two weeks",
      },
      U("eng"),
      {},
      db,
    );
    expect(proposed.state).toBe("proposed");
    // Only the issuer's person confirms; an agent can't.
    await expect(
      confirmTranslation(
        { assignment: proposed.id, ok: true },
        U("eng"),
        {},
        db,
      ),
    ).rejects.toThrow(Forbidden);
    // Sent back: the unit translates again, reading the note.
    const back = await confirmTranslation(
      { assignment: proposed.id, ok: false, note: "Trial-to-paid first" },
      FOUNDER,
      { now: new Date("2026-10-31T10:00:00Z") },
      db,
    );
    expect([back.state, back.note]).toEqual(["new", "Trial-to-paid first"]);
    const guidelines = await getUnitDoc(
      { unit: "eng", name: "guidelines" },
      db,
    );
    expect(guidelines?.version).toBe(1);
    expect(guidelines?.body).toBe(
      `- 2026-10-31 · directive ${d.id} "First paying customer": translation sent back: Trial-to-paid first`,
    );
    await translateDirective(
      { directive: d.id, unit: "eng", translation: "Ship trial-to-paid" },
      U("eng"),
      {},
      db,
    );
    const ok = await confirmTranslation(
      { assignment: proposed.id, ok: true },
      FOUNDER,
      {},
      db,
    );
    expect([ok.state, ok.translation, ok.note]).toEqual([
      "active",
      "Ship trial-to-paid",
      null,
    ]);
    await expect(
      confirmTranslation(
        { assignment: proposed.id, ok: true },
        FOUNDER,
        {},
        db,
      ),
    ).rejects.toThrow(/isn't waiting/);

    // Deeper down, translations take effect without the person.
    const passed = await issueDirective(
      { ...GOAL, from: "mkt", to: ["seo"], parentId: d.id },
      U("mkt"),
      {},
      db,
    );
    expect(passed.assignments[0].needsConfirm).toBe(false);
    const seo = await translateDirective(
      {
        directive: passed.id,
        unit: "seo",
        translation: "Leaderboard page with a trial entry",
      },
      U("seo"),
      {},
      db,
    );
    expect(seo.state).toBe("active");
  });

  it("lets a unit say a directive isn't its own, with why", async () => {
    const db = await tree();
    const d = await issueDirective(GOAL, FOUNDER, {}, db);
    await expect(
      translateDirective(
        { directive: d.id, unit: "eval", relevant: false },
        U("eval"),
        {},
        db,
      ),
    ).rejects.toThrow(/why/);
    const no = await translateDirective(
      {
        directive: d.id,
        unit: "eval",
        relevant: false,
        reason: "Evaluation doesn't touch billing",
      },
      U("eval"),
      {},
      db,
    );
    expect([no.state, no.note]).toEqual([
      "declined",
      "Evaluation doesn't touch billing",
    ]);
    await expect(
      translateDirective(
        { directive: d.id, unit: "seo", translation: "x" },
        U("seo"),
        {},
        db,
      ),
    ).rejects.toThrow(/wasn't sent to seo/);
  });

  it("passes on only what the unit was sent", async () => {
    const db = await tree();
    const d = await issueDirective(GOAL, FOUNDER, {}, db);
    await expect(
      issueDirective(
        { ...GOAL, from: "seo", to: ["eng"], parentId: d.id },
        U("seo"),
        {},
        db,
      ),
    ).rejects.toThrow(/only pass on/);
    await expect(
      issueDirective({ ...GOAL, to: [] }, FOUNDER, {}, db),
    ).rejects.toThrow(/at least one/);
    await expect(
      issueDirective({ ...GOAL, dueOn: "next week" }, FOUNDER, {}, db),
    ).rejects.toThrow(/YYYY-MM-DD/);
  });

  it("is closed by its issuer only, taking its passed-on directives and unstarted tasks with it", async () => {
    const db = await tree();
    const d = await issueDirective(GOAL, FOUNDER, {}, db);
    const passed = await issueDirective(
      { ...GOAL, from: "mkt", to: ["seo"], parentId: d.id },
      U("mkt"),
      {},
      db,
    );
    await addTask(
      { unit: "seo", title: "x", directive: passed.id },
      U("seo"),
      {},
      db,
    );
    expect((await directiveChain(d.id, db)).map((c) => c.id)).toEqual([
      passed.id,
    ]);

    await expect(
      closeDirective(
        { directive: d.id, unit: "mkt", status: "done", outcome: "x" },
        U("mkt"),
        {},
        db,
      ),
    ).rejects.toThrow(/Only company/);
    const closed = await closeDirective(
      {
        directive: d.id,
        unit: "company",
        status: "done",
        outcome: "The first merchant paid $49",
      },
      FOUNDER,
      {},
      db,
    );
    expect(closed.status).toBe("done");
    expect(closed.assignments.every((a) => a.state === "closed")).toBe(true);
    const child = (await getDirective(passed.id, db))!;
    expect([child.status, child.outcome]).toEqual([
      "done",
      `Closed with directive ${d.id}: The first merchant paid $49`,
    ]);
    expect(await listTasks({ unit: "seo" }, db)).toEqual([]);
    await expect(
      translateDirective(
        { directive: d.id, unit: "eng", translation: "x" },
        U("eng"),
        {},
        db,
      ),
    ).rejects.toThrow(/closed/);
  });
});
