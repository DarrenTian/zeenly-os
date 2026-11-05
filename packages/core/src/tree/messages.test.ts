import { describe, expect, it } from "vitest";

import { createTestDb } from "../test-db";
import type { Actor } from "./actors";
import { getUnitDoc } from "./docs";
import { Forbidden } from "./errors";
import {
  answers,
  inbox,
  passOnEscalation,
  resolveMessage,
  sendMessage,
  waitingOnPeople,
} from "./messages";
import { createUnit, updateUnit } from "./units";

const FOUNDER: Actor = { kind: "human", id: "founder" };
const U = (id: string): Actor => ({ kind: "unit", id });

/** company (steered) → growth (autopilot) → mkt, seo (autopilot); eng beside growth. */
async function tree() {
  const db = await createTestDb();
  await createUnit(
    { id: "company", name: "Company", summary: "The company" },
    FOUNDER,
    {},
    db,
  );
  await createUnit(
    {
      id: "growth",
      parentId: "company",
      name: "Growth",
      summary: "x",
      mode: "autopilot",
    },
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
  for (const id of ["mkt", "seo"]) {
    await createUnit(
      { id, parentId: "growth", name: id, summary: "x", mode: "autopilot" },
      FOUNDER,
      {},
      db,
    );
  }
  return db;
}

describe("escalations", () => {
  it("wait first on an autopilot parent's agent, climb to a person when passed on, and the decision becomes a guideline", async () => {
    const db = await tree();
    const m = await sendMessage(
      {
        from: "mkt",
        kind: "escalation",
        subject: "Lower the price or not",
        body: "Options: A/B, I'd pick A",
      },
      U("mkt"),
      {},
      db,
    );
    expect([m.toUnit, m.forPerson, m.path, m.sentBy]).toEqual([
      "growth",
      false,
      ["mkt", "growth"],
      "unit:mkt",
    ]);
    expect(
      (await inbox("growth", { forPerson: false }, db)).map((x) => x.id),
    ).toEqual([m.id]);

    await expect(
      passOnEscalation({ message: m.id, unit: "eng" }, U("eng"), {}, db),
    ).rejects.toThrow(/waits on growth/);
    await expect(
      passOnEscalation({ message: m.id, unit: "growth" }, U("eng"), {}, db),
    ).rejects.toThrow(Forbidden);
    const up = await passOnEscalation(
      { message: m.id, unit: "growth", note: "Touches pricing, beyond me" },
      U("growth"),
      {},
      db,
    );
    expect([up.toUnit, up.forPerson, up.path]).toEqual([
      "company",
      true,
      ["mkt", "growth", "company"],
    ]);
    expect(up.body).toContain("growth: Touches pricing, beyond me");
    expect((await waitingOnPeople(db)).map((x) => x.id)).toEqual([m.id]);

    // On a person's desk, an agent can't settle it; the person can.
    await expect(
      resolveMessage({ message: m.id, resolution: "A" }, U("company"), {}, db),
    ).rejects.toThrow(/person/);
    const done = await resolveMessage(
      { message: m.id, resolution: "Pick A" },
      FOUNDER,
      { now: new Date("2026-10-31T10:00:00Z") },
      db,
    );
    expect([done.status, done.resolution, done.resolvedBy]).toEqual([
      "resolved",
      "Pick A",
      "human:founder",
    ]);
    expect((await answers("mkt", null, db)).map((x) => x.id)).toEqual([m.id]);
    // The asking unit learns the decision.
    const guidelines = await getUnitDoc(
      { unit: "mkt", name: "guidelines" },
      db,
    );
    expect(guidelines?.body).toBe(
      "- 2026-10-31 · Lower the price or not → Pick A",
    );
    expect(guidelines?.reason).toBe(`Decided escalation ${m.id}`);
    // The unit that merely held it learns nothing.
    expect(await getUnitDoc({ unit: "growth", name: "guidelines" }, db)).toBe(
      null,
    );
  });

  it("stop at once on a steered unit's person, or a root's", async () => {
    const db = await tree();
    // eng is steered: its own person decides what its agent can't.
    const fromEng = await sendMessage(
      { from: "eng", kind: "escalation", subject: "x" },
      U("eng"),
      {},
      db,
    );
    expect([fromEng.toUnit, fromEng.forPerson]).toEqual(["eng", true]);
    // growth's parent is the steered root.
    const fromGrowth = await sendMessage(
      { from: "growth", kind: "escalation", subject: "x" },
      U("growth"),
      {},
      db,
    );
    expect([fromGrowth.toUnit, fromGrowth.forPerson]).toEqual([
      "company",
      true,
    ]);
    // An autopilot root still has a person.
    await updateUnit("company", { mode: "autopilot" }, FOUNDER, {}, db);
    const fromRoot = await sendMessage(
      { from: "company", kind: "escalation", subject: "x" },
      U("company"),
      {},
      db,
    );
    expect([fromRoot.toUnit, fromRoot.forPerson]).toEqual(["company", true]);
  });

  it("can be settled by the autopilot unit holding it, which teaches nobody", async () => {
    const db = await tree();
    const m = await sendMessage(
      { from: "seo", kind: "escalation", subject: "x" },
      U("seo"),
      {},
      db,
    );
    const settled = await resolveMessage(
      { message: m.id, resolution: "Go with A" },
      U("growth"),
      {},
      db,
    );
    expect(settled.status).toBe("resolved");
    expect(await getUnitDoc({ unit: "seo", name: "guidelines" }, db)).toBe(
      null,
    );
    await expect(
      resolveMessage({ message: m.id, resolution: "x" }, U("growth"), {}, db),
    ).rejects.toThrow(/settled already/);
  });
});

describe("requests", () => {
  it("go to a peer, which answers or declines", async () => {
    const db = await tree();
    await expect(
      sendMessage(
        { from: "mkt", kind: "request", subject: "x" },
        U("mkt"),
        {},
        db,
      ),
    ).rejects.toThrow(/needs a unit/);
    const r = await sendMessage(
      {
        from: "mkt",
        kind: "request",
        to: "eng",
        subject: "Add a landing page",
      },
      U("mkt"),
      {},
      db,
    );
    expect([r.toUnit, r.forPerson]).toEqual(["eng", false]);
    // Only eng (its agent or person) answers what waits on eng.
    await expect(
      resolveMessage({ message: r.id, resolution: "x" }, U("mkt"), {}, db),
    ).rejects.toThrow(Forbidden);
    const no = await resolveMessage(
      { message: r.id, resolution: "This week is full", decline: true },
      U("eng"),
      {},
      db,
    );
    expect(no.status).toBe("declined");
    const e = await sendMessage(
      { from: "mkt", kind: "escalation", subject: "x" },
      U("mkt"),
      {},
      db,
    );
    await expect(
      resolveMessage(
        { message: e.id, resolution: "x", decline: true },
        U("growth"),
        {},
        db,
      ),
    ).rejects.toThrow(/Only a request/);
  });
});
