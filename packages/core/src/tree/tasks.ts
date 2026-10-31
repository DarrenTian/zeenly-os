/**
 * A unit's tasks: its structured to-do. Its agent adds them from its
 * translations; any session can claim one and finish it.
 */

import { and, asc, eq, inArray } from "drizzle-orm";

import { db as defaultDb, type Database } from "../db";
import { directiveAssignments, unitTasks } from "../db/schema";
import { getUnit, TreeError } from "./units";

export type TaskStatus = "open" | "doing" | "done" | "dropped";

export type Task = typeof unitTasks.$inferSelect;

export async function addTask(
  input: {
    unit: string;
    title: string;
    detail?: string;
    priority?: number;
    directive?: number | null;
    source: string;
    /** Its person placed it; re-ranks leave its priority alone. */
    pinned?: boolean;
  },
  database: Database = defaultDb(),
): Promise<Task> {
  if (!(await getUnit(input.unit, database))) {
    throw new TreeError(`No unit "${input.unit}"`);
  }
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
  const [row] = await database
    .insert(unitTasks)
    .values({
      unitId: input.unit,
      title,
      detail: input.detail?.trim() ?? "",
      priority,
      directiveId: input.directive ?? null,
      source: input.source,
      pinned: input.pinned ?? false,
    })
    .returning();
  return row;
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

/** A session takes an open task; another session's claim stands. */
export async function claimTask(
  input: { task: number; by: string },
  { now = new Date() }: { now?: Date } = {},
  database: Database = defaultDb(),
): Promise<Task> {
  const task = await requireTask(input.task, database);
  if (task.status !== "open") {
    throw new TreeError(
      `Task ${task.id} is ${task.status}${task.claimedBy ? ` (${task.claimedBy})` : ""}`,
    );
  }
  const [row] = await database
    .update(unitTasks)
    .set({ status: "doing", claimedBy: input.by, updatedAt: now })
    .where(and(eq(unitTasks.id, task.id), eq(unitTasks.status, "open")))
    .returning();
  if (!row) throw new TreeError(`Task ${task.id} was just claimed`);
  return row;
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
  { now = new Date() }: { now?: Date } = {},
  database: Database = defaultDb(),
): Promise<Task> {
  const task = await requireTask(input.task, database);
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
    input.priority !== undefined &&
    input.priority !== task.priority
  ) {
    throw new TreeError(
      `Task ${task.id} is pinned by its person; its priority stays where it is`,
    );
  }
  const [row] = await database
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
}

async function requireTask(id: number, database: Database): Promise<Task> {
  const [task] = await database
    .select()
    .from(unitTasks)
    .where(eq(unitTasks.id, id));
  if (!task) throw new TreeError(`No task ${id}`);
  return task;
}
