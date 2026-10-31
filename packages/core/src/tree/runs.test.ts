import { describe, expect, it } from "vitest";

import { createTestDb } from "../test-db";
import { type Actor, SCHEDULER } from "./actors";
import { Forbidden } from "./errors";
import { listEvents } from "./events";
import { recordRun } from "./runs";
import { createUnit } from "./units";

const FOUNDER: Actor = { kind: "human", id: "founder" };
const T0 = new Date("2026-10-31T09:00:00Z");

describe("a session run", () => {
  it("is an event on the unit with its cost and its log, recorded by the scheduler", async () => {
    const db = await createTestDb();
    await createUnit({ id: "eng", name: "x", summary: "x" }, FOUNDER, {}, db);
    const run = {
      unit: "eng",
      log: "/data/logs/eng/2026-10-31T09-00-00Z.jsonl",
      outcome: "done" as const,
      costUsd: 0.42,
      durationMs: 183_000,
      turns: 11,
      sessionId: "abc",
    };
    const event = await recordRun(run, SCHEDULER, { now: T0 }, db);
    expect([event.what, event.actorKind, event.actorId, event.unitId]).toEqual([
      "session.ran",
      "system",
      "scheduler",
      "eng",
    ]);
    // The unit is the event's own unit_id, not repeated inside.
    expect(event.after).toEqual({
      log: run.log,
      outcome: "done",
      costUsd: 0.42,
      durationMs: 183_000,
      turns: 11,
      sessionId: "abc",
      detail: null,
    });
    expect((await listEvents({ unit: "eng" }, db)).map((e) => e.what)).toEqual([
      "session.ran",
      "unit.created",
    ]);
    await expect(
      recordRun(run, { kind: "unit", id: "eng" }, {}, db),
    ).rejects.toThrow(Forbidden);
    await expect(
      recordRun({ ...run, unit: "nope" }, SCHEDULER, {}, db),
    ).rejects.toThrow(/No unit "nope"/);
  });
});
