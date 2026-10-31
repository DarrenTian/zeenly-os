import { describe, expect, it } from "vitest";

import { createTestDb } from "../test-db";
import type { Actor } from "./actors";
import { Forbidden } from "./errors";
import { latestReports, rollUp, submitReport } from "./reports";
import { createUnit, listUnits } from "./units";

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
  await createUnit(
    { id: "other", name: "别的树", summary: "x" },
    FOUNDER,
    {},
    db,
  );
  return db;
}

const T0 = new Date("2026-10-25T10:00:00Z");

describe("reports", () => {
  it("lets a leaf report in plain sentences, for its own unit only", async () => {
    const db = await tree();
    const r = await submitReport(
      {
        unit: "eng",
        status: "ok",
        headline: "付费墙上线了",
        done: ["合并 #130"],
        numbers: [{ name: "付费商家", value: 0, target: 1 }],
      },
      U("eng"),
      { now: T0 },
      db,
    );
    expect(r.headline).toEqual({ text: "付费墙上线了", cites: [] });
    expect(r.done).toEqual([{ text: "合并 #130", cites: [] }]);
    expect(r.author).toBe("unit:eng");
    await expect(
      submitReport(
        { unit: "mkt", status: "ok", headline: "x" },
        U("eng"),
        {},
        db,
      ),
    ).rejects.toThrow(Forbidden);
  });

  it("makes a parent cite its children's reports in every sentence", async () => {
    const db = await tree();
    const eng = await submitReport(
      {
        unit: "eng",
        status: "risk",
        headline: "支付还没接",
        blocked: ["等 Stripe 账户"],
      },
      U("eng"),
      { now: T0 },
      db,
    );
    const elsewhere = await submitReport(
      { unit: "other", status: "ok", headline: "x" },
      U("other"),
      { now: T0 },
      db,
    );
    await expect(
      submitReport(
        {
          unit: "company",
          status: "risk",
          headline: { text: "首个付费客户有风险", cites: [eng.id] },
          done: ["营销进展顺利"],
        },
        U("company"),
        {},
        db,
      ),
    ).rejects.toThrow(/“营销进展顺利”/);
    await expect(
      submitReport(
        {
          unit: "company",
          status: "ok",
          headline: { text: "x", cites: [elsewhere.id] },
        },
        U("company"),
        {},
        db,
      ),
    ).rejects.toThrow(/aren't from units below company/);
    const ok = await submitReport(
      {
        unit: "company",
        status: "risk",
        headline: { text: "首个付费客户卡在支付", cites: [eng.id] },
      },
      U("company"),
      { now: T0 },
      db,
    );
    expect(ok.headline.cites).toEqual([eng.id]);
  });

  it("says what a stuck unit is stuck on", async () => {
    const db = await tree();
    await expect(
      submitReport(
        { unit: "eng", status: "stuck", headline: "卡住了" },
        U("eng"),
        {},
        db,
      ),
    ).rejects.toThrow(/blocked/);
  });

  it("colours each unit by the worst latest status in its subtree", async () => {
    const db = await tree();
    await submitReport(
      { unit: "eng", status: "stuck", headline: "x", blocked: ["y"] },
      U("eng"),
      { now: T0 },
      db,
    );
    // A newer report replaces the older one.
    await submitReport(
      { unit: "eng", status: "ok", headline: "好了" },
      U("eng"),
      { now: new Date(T0.getTime() + 1000) },
      db,
    );
    await submitReport(
      { unit: "mkt", status: "risk", headline: "x" },
      U("mkt"),
      { now: T0 },
      db,
    );
    const latest = await latestReports(db);
    expect(latest.get("eng")?.headline.text).toBe("好了");
    const rolled = rollUp(await listUnits(db), latest);
    expect(Object.fromEntries(rolled)).toEqual({
      company: "risk",
      eng: "ok",
      mkt: "risk",
      other: null,
    });
  });
});
