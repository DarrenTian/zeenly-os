import { describe, expect, it } from "vitest";

import { createTestDb } from "../test-db";
import { latestReports, rollUp, submitReport } from "./reports";
import { createUnit, listUnits } from "./units";

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
  await createUnit({ id: "other", name: "别的树", summary: "x" }, db);
  return db;
}

const T0 = new Date("2026-10-25T10:00:00Z");

describe("reports", () => {
  it("lets a leaf report in plain sentences", async () => {
    const db = await tree();
    const r = await submitReport(
      {
        unit: "eng",
        status: "ok",
        headline: "付费墙上线了",
        done: ["合并 #130"],
        numbers: [{ name: "付费商家", value: 0, target: 1 }],
        by: "s",
      },
      { now: T0 },
      db,
    );
    expect(r.headline).toEqual({ text: "付费墙上线了", cites: [] });
    expect(r.done).toEqual([{ text: "合并 #130", cites: [] }]);
  });

  it("makes a parent cite its children's reports in every sentence", async () => {
    const db = await tree();
    const eng = await submitReport(
      {
        unit: "eng",
        status: "risk",
        headline: "支付还没接",
        blocked: ["等 Stripe 账户"],
        by: "s",
      },
      { now: T0 },
      db,
    );
    const elsewhere = await submitReport(
      { unit: "other", status: "ok", headline: "x", by: "s" },
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
          by: "s",
        },
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
          by: "s",
        },
        {},
        db,
      ),
    ).rejects.toThrow(/aren't from units below company/);
    const ok = await submitReport(
      {
        unit: "company",
        status: "risk",
        headline: { text: "首个付费客户卡在支付", cites: [eng.id] },
        by: "s",
      },
      { now: T0 },
      db,
    );
    expect(ok.headline.cites).toEqual([eng.id]);
  });

  it("says what a stuck unit is stuck on", async () => {
    const db = await tree();
    await expect(
      submitReport(
        { unit: "eng", status: "stuck", headline: "卡住了", by: "s" },
        {},
        db,
      ),
    ).rejects.toThrow(/blocked/);
  });

  it("colours each unit by the worst latest status in its subtree", async () => {
    const db = await tree();
    await submitReport(
      { unit: "eng", status: "stuck", headline: "x", blocked: ["y"], by: "s" },
      { now: T0 },
      db,
    );
    // A newer report replaces the older one.
    await submitReport(
      { unit: "eng", status: "ok", headline: "好了", by: "s" },
      { now: new Date(T0.getTime() + 1000) },
      db,
    );
    await submitReport(
      { unit: "mkt", status: "risk", headline: "x", by: "s" },
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
