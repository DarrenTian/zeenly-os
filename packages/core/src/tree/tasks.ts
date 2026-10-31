/**
 * A unit's tasks: its structured to-do. Its agent adds them from its
 * translations and works them; its person can add one too, and a task a
 * person placed keeps the priority they gave it.
 */

import { and, asc, eq, inArray } from "drizzle-orm";

import { db as defaultDb, type Database } from "../db";
import { directiveAssignments, unitTasks } from "../db/schema";
import { type Actor, actorLabel } from "./actors";
import { TreeError } from "./errors";
import { write } from "./events";
import { listUnits, requireActsFor } from "./units";

export type TaskStatus = "open" | "doing" | "done" | "dropped";

export type Task = typeof unitTasks.$inferSelect;

export async function addTask(
  input: {
    unit: string;
    title: string;
    detail?: string;
    priority?: number;
    directive?: number | null;
  },
  by: Actor,
  { now = new Date() }: { now?: Date } = {},
  database: Database = defaultDb(),
): Promise<Task> {
  const all = await listUnits(database);
  requireActsFor(all, by, input.unit, "add a task to it");
  const title = input.title.trim();
  if (!title) throw new TreeError("Give the task a title");
  const priority = input.priority ?? 2;
  if (!Number.isInteger(priority) || priority < 0 || priority > 3) {
    throw new TreeError("priority is 0 (most urgent) to 3");
  }
  if (input.directive != null) {
    // A task serves one of the unit's own directives, not someone else's.
    const [part] = await database
      .select()
      .from(directiveAssignments)
      .where(
        and(
          eq(directiveAssignments.directiveId, input.directive),
          eq(directiveAssignments.unitId, input.unit),
        ),
      );
    if (!part) {
      throw new TreeError(
        `Directive ${input.directive} wasn't sent to ${input.unit}`,
      );
    }
  }
  return write(
    database,
    by,
    async (tx) => {
      const [row] = await tx
        .insert(unitTasks)
        .values({
          unitId: input.unit,
          title,
          detail: input.detail?.trim() ?? "",
          priority,
          directiveId: input.directive ?? null,
          source: actorLabel(by),
          pinned: by.kind === "human",
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return row;
    },
    (t) => ({
      what: "task.added",
      on: { kind: "task", id: t.id },
      unit: input.unit,
      why: input.directive != null ? `directive:${input.directive}` : null,
    }),
    now,
  );
}

/** A unit's tasks, most urgent first; open and doing unless `statuses`. */
export async function listTasks(
  {
    unit,
    statuses = ["open", "doing"],
  }: { unit?: string; statuses?: TaskStatus[] } = {},
  database: Database = defaultDb(),
): Promise<Task[]> {
  return database
    .select()
    .from(unitTasks)
    .where(
      and(
        unit ? eq(unitTasks.unitId, unit) : undefined,
        inArray(unitTasks.status, statuses),
      ),
    )
    .orderBy(asc(unitTasks.priority), asc(unitTasks.id));
}

/** Whoever acts for the unit takes an open task; a standing claim stands. */
export async function claimTask(
  input: { task: number },
  by: Actor,
  { now = new Date() }: { now?: Date } = {},
  database: Database = defaultDb(),
): Promise<Task> {
  const task = await requireTask(input.task, database);
  requireActsFor(await listUnits(database), by, task.unitId, "claim its task");
  if (task.status !== "open") {
    throw new TreeError(
      `Task ${task.id} is ${task.status}${task.claimedBy ? ` (${task.claimedBy})` : ""}`,
    );
  }
  return write(
    database,
    by,
    async (tx) => {
      const [row] = await tx
        .update(unitTasks)
        .set({ status: "doing", claimedBy: actorLabel(by), updatedAt: now })
        .where(and(eq(unitTasks.id, task.id), eq(unitTasks.status, "open")))
        .returning();
      if (!row) throw new TreeError(`Task ${task.id} was just claimed`);
      return row;
    },
    () => ({
      what: "task.claimed",
      on: { kind: "task", id: task.id },
      unit: task.unitId,
      why: task.directiveId != null ? `directive:${task.directiveId}` : null,
    }),
    now,
  );
}

export async function updateTask(
  input: {
    task: number;
    status?: TaskStatus;
    title?: string;
    detail?: string;
    priority?: number;
    prUrl?: string;
  },
  by: Actor,
  { now = new Date() }: { now?: Date } = {},
  database: Database = defaultDb(),
): Promise<Task> {
  const task = await requireTask(input.task, database);
  requireActsFor(await listUnits(database), by, task.unitId, "change its task");
  if (
    input.priority !== undefined &&
    (!Number.isInteger(input.priority) ||
      input.priority < 0 ||
      input.priority > 3)
  ) {
    throw new TreeError("priority is 0 (most urgent) to 3");
  }
  if (
    task.pinned &&
    by.kind !== "human" &&
    input.priority !== undefined &&
    input.priority !== task.priority
  ) {
    throw new TreeError(
      `Task ${task.id} is pinned by its person; its priority stays where it is`,
    );
  }
  return write(
    database,
    by,
    async (tx) => {
      const [row] = await tx
        .update(unitTasks)
        .set({
          ...(input.status && { status: input.status }),
          ...(input.title?.trim() && { title: input.title.trim() }),
          ...(input.detail !== undefined && { detail: input.detail.trim() }),
          ...(input.priority !== undefined && { priority: input.priority }),
          ...(input.prUrl && { prUrl: input.prUrl }),
          ...(input.status === "open" && { claimedBy: null }),
          updatedAt: now,
        })
        .where(eq(unitTasks.id, task.id))
        .returning();
      return row;
    },
    (after) => ({
      what: "task.updated",
      on: { kind: "task", id: task.id },
      unit: task.unitId,
      why: task.directiveId != null ? `directive:${task.directiveId}` : null,
      before: {
        status: task.status,
        priority: task.priority,
        prUrl: task.prUrl,
      },
      after: {
        status: after.status,
        priority: after.priority,
        prUrl: after.prUrl,
      },
    }),
    now,
  );
}

async function requireTask(id: number, database: Database): Promise<Task> {
  const [task] = await database
    .select()
    .from(unitTasks)
    .where(eq(unitTasks.id, id));
  if (!task) throw new TreeError(`No task ${id}`);
  return task;
}
