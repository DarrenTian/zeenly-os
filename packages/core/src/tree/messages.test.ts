import { describe, expect, it } from "vitest";

import { createTestDb } from "../test-db";
import {
  answers,
  inbox,
  passOnEscalation,
  resolveMessage,
  sendMessage,
  waitingOnPeople,
} from "./messages";
import { createUnit, updateUnit } from "./units";

/** company (steered) → growth (autopilot) → mkt, seo (autopilot); eng beside growth. */
async function tree() {
  const db = await createTestDb();
  await createUnit({ id: "company", name: "Company", summary: "公司" }, db);
  await createUnit(
    {
      id: "growth",
      parentId: "company",
      name: "增长",
      summary: "x",
      mode: "autopilot",
    },
    db,
  );
  await createUnit(
    { id: "eng", parentId: "company", name: "工程", summary: "x" },
    db,
  );
  for (const id of ["mkt", "seo"]) {
    await createUnit(
      { id, parentId: "growth", name: id, summary: "x", mode: "autopilot" },
      db,
    );
  }
  return db;
}

describe("escalations", () => {
  it("wait first on an autopilot parent's agent, and climb to a person when passed on", async () => {
    const db = await tree();
    const m = await sendMessage(
      {
        from: "mkt",
        kind: "escalation",
        subject: "要不要降价",
        body: "选项：A/B，我选 A",
        by: "s",
      },
      db,
    );
    expect([m.toUnit, m.forPerson, m.path]).toEqual([
      "growth",
      false,
      ["mkt", "growth"],
    ]);
    expect(
      (await inbox("growth", { forPerson: false }, db)).map((x) => x.id),
    ).toEqual([m.id]);

    await expect(
      passOnEscalation({ message: m.id, unit: "eng" }, db),
    ).rejects.toThrow(/waits on growth/);
    const up = await passOnEscalation(
      { message: m.id, unit: "growth", note: "动定价，超出我" },
      db,
    );
    expect([up.toUnit, up.forPerson, up.path]).toEqual([
      "company",
      true,
      ["mkt", "growth", "company"],
    ]);
    expect(up.body).toContain("growth：动定价，超出我");
    expect((await waitingOnPeople(db)).map((x) => x.id)).toEqual([m.id]);

    // On a person's desk, an agent can't settle it; the person can.
    await expect(
      resolveMessage(
        { message: m.id, unit: "company", resolution: "A", by: "s" },
        {},
        db,
      ),
    ).rejects.toThrow(/person/);
    const done = await resolveMessage(
      { message: m.id, person: "founder", resolution: "选 A", by: "founder" },
      {},
      db,
    );
    expect([done.status, done.resolution]).toEqual(["resolved", "选 A"]);
    expect((await answers("mkt", null, db)).map((x) => x.id)).toEqual([m.id]);
  });

  it("stop at once on a steered unit's person, or a root's", async () => {
    const db = await tree();
    // eng is steered: its own person decides what its agent can't.
    const fromEng = await sendMessage(
      { from: "eng", kind: "escalation", subject: "x", by: "s" },
      db,
    );
    expect([fromEng.toUnit, fromEng.forPerson]).toEqual(["eng", true]);
    // growth's parent is the steered root.
    const fromGrowth = await sendMessage(
      { from: "growth", kind: "escalation", subject: "x", by: "s" },
      db,
    );
    expect([fromGrowth.toUnit, fromGrowth.forPerson]).toEqual([
      "company",
      true,
    ]);
    // An autopilot root still has a person.
    await updateUnit("company", { mode: "autopilot" }, {}, db);
    const fromRoot = await sendMessage(
      { from: "company", kind: "escalation", subject: "x", by: "s" },
      db,
    );
    expect([fromRoot.toUnit, fromRoot.forPerson]).toEqual(["company", true]);
  });

  it("can be settled by the autopilot unit holding it", async () => {
    const db = await tree();
    const m = await sendMessage(
      { from: "seo", kind: "escalation", subject: "x", by: "s" },
      db,
    );
    const settled = await resolveMessage(
      { message: m.id, unit: "growth", resolution: "按 A 做", by: "s" },
      {},
      db,
    );
    expect(settled.status).toBe("resolved");
    await expect(
      resolveMessage(
        { message: m.id, unit: "growth", resolution: "x", by: "s" },
        {},
        db,
      ),
    ).rejects.toThrow(/settled already/);
  });
});

describe("requests", () => {
  it("go to a peer, which answers or declines", async () => {
    const db = await tree();
    await expect(
      sendMessage({ from: "mkt", kind: "request", subject: "x", by: "s" }, db),
    ).rejects.toThrow(/needs a unit/);
    const r = await sendMessage(
      {
        from: "mkt",
        kind: "request",
        to: "eng",
        subject: "加一个落地页",
        by: "s",
      },
      db,
    );
    expect([r.toUnit, r.forPerson]).toEqual(["eng", false]);
    const no = await resolveMessage(
      {
        message: r.id,
        unit: "eng",
        resolution: "这周排满",
        decline: true,
        by: "s",
      },
      {},
      db,
    );
    expect(no.status).toBe("declined");
    const e = await sendMessage(
      { from: "mkt", kind: "escalation", subject: "x", by: "s" },
      db,
    );
    await expect(
      resolveMessage(
        {
          message: e.id,
          unit: "growth",
          resolution: "x",
          decline: true,
          by: "s",
        },
        {},
        db,
      ),
    ).rejects.toThrow(/Only a request/);
  });
});
