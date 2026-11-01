/**
 * A session run: the scheduler woke a unit's agent, it ran, and this is
 * what it cost and where its full log is. The log stays outside the tree
 * (a file per session); the event carries the pointer and the numbers, so
 * a unit's activity stream shows every run and a page can drill down.
 */

import { db as defaultDb, type Database } from "../db";
import type { Actor } from "./actors";
import { Forbidden, TreeError } from "./errors";
import { listEvents, write, type Event } from "./events";
import { findUnit, listUnits } from "./units";

export type RunOutcome = "done" | "failed" | "budget" | "timeout";

export type Run = {
  unit: string;
  /** Where the session's full output is kept. */
  log: string;
  outcome: RunOutcome;
  costUsd: number | null;
  durationMs: number;
  turns: number | null;
  /** The session's id with its runner, if it gave one. */
  sessionId?: string | null;
  /** One line on how it ended, for a failure. */
  detail?: string | null;
};

/** The scheduler (or a person running a unit by hand) records a run. */
export async function recordRun(
  input: Run,
  by: Actor,
  { now = new Date() }: { now?: Date } = {},
  database: Database = defaultDb(),
): Promise<Event> {
  if (by.kind === "unit") {
    throw new Forbidden("A unit's agent doesn't record its own runs");
  }
  findUnit(await listUnits(database), input.unit);
  if (!input.log.trim()) throw new TreeError("Say where the log is");
  const after = {
    log: input.log,
    outcome: input.outcome,
    costUsd: input.costUsd,
    durationMs: input.durationMs,
    turns: input.turns,
    sessionId: input.sessionId ?? null,
    detail: input.detail ?? null,
  };
  return write(
    database,
    by,
    async (tx) => {
      // Nothing in the tables changes: the run is only its event. Writing it
      // through `write` keeps the one entry point and the transaction.
      void tx;
      return after;
    },
    () => ({
      what: "session.ran",
      on: { kind: "session", id: input.log },
      unit: input.unit,
      after,
    }),
    now,
  ).then(() =>
    listEvents({ unit: input.unit, limit: 1 }, database).then((e) => e[0]),
  );
}
