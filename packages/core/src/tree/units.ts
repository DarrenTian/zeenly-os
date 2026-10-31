/**
 * The function tree's units: standing roles, each with a charter, a person
 * who steers it and a mode. Everything else in the tree (directives, tasks,
 * messages, reports) hangs off a unit.
 */

import { asc, eq, or } from "drizzle-orm";

import { db as defaultDb, type Database } from "../db";
import {
  directiveAssignments,
  directives,
  unitDocs,
  unitMessages,
  unitReports,
  units,
  unitTasks,
} from "../db/schema";

/** A call the tree can't take; the message says why, for the agent or page. */
export class TreeError extends Error {}

export type UnitMode = "steer" | "autopilot";

export type Unit = {
  id: string;
  parentId: string | null;
  name: string;
  summary: string;
  charter: string;
  owner: string | null;
  mode: UnitMode;
  position: number;
};

const SLUG = /^[a-z][a-z0-9-]{1,39}$/;

export async function createUnit(
  input: {
    id: string;
    parentId?: string | null;
    name: string;
    summary: string;
    charter?: string;
    owner?: string | null;
    mode?: UnitMode;
  },
  database: Database = defaultDb(),
): Promise<Unit> {
  if (!SLUG.test(input.id) || input.id.endsWith("-")) {
    throw new TreeError(
      "A unit's id is 2–40 lower-case letters, digits and dashes, starting with a letter",
    );
  }
  // The tree's pages use /tree/directives.
  if (input.id === "directives") {
    throw new TreeError(`"directives" is a page already`);
  }
  const name = input.name.trim();
  const summary = input.summary.trim();
  if (!name || !summary)
    throw new TreeError("Give the unit a name and summary");
  if (await getUnit(input.id, database)) {
    throw new TreeError(`There's a unit "${input.id}" already`);
  }
  const all = await listUnits(database);
  const parentId = input.parentId ?? null;
  if (parentId && !all.some((u) => u.id === parentId)) {
    throw new TreeError(`No unit "${parentId}"`);
  }
  const position =
    Math.max(
      -1,
      ...all.filter((u) => u.parentId === parentId).map((u) => u.position),
    ) + 1;
  const [row] = await database
    .insert(units)
    .values({
      id: input.id,
      parentId,
      name,
      summary,
      charter: input.charter?.trim() ?? "",
      // A root with no owner would leave its escalations with nobody.
      owner: input.owner ?? (parentId ? null : "founder"),
      mode: input.mode ?? "steer",
      position,
    })
    .returning();
  return toUnit(row);
}

/** Changes what's given; moving a unit under its own subtree is refused. */
export async function updateUnit(
  id: string,
  patch: {
    name?: string;
    summary?: string;
    charter?: string;
    owner?: string | null;
    mode?: UnitMode;
    parentId?: string | null;
    /** Its place among its siblings, smallest first. */
    position?: number;
  },
  { now = new Date() }: { now?: Date } = {},
  database: Database = defaultDb(),
): Promise<Unit> {
  const all = await listUnits(database);
  const unit = findUnit(all, id);
  if (patch.parentId !== undefined && patch.parentId !== null) {
    findUnit(all, patch.parentId);
    if (
      patch.parentId === id ||
      ancestors(all, patch.parentId).some((u) => u.id === id)
    ) {
      throw new TreeError(`"${id}" can't sit under its own subtree`);
    }
  }
  const values = {
    ...(patch.name?.trim() && { name: patch.name.trim() }),
    ...(patch.summary?.trim() && { summary: patch.summary.trim() }),
    ...(patch.charter !== undefined && { charter: patch.charter.trim() }),
    ...(patch.owner !== undefined && { owner: patch.owner }),
    ...(patch.mode && { mode: patch.mode }),
    ...(patch.parentId !== undefined && { parentId: patch.parentId }),
    ...(patch.position !== undefined && { position: patch.position }),
  };
  if (!Object.keys(values).length) return unit;
  const [row] = await database
    .update(units)
    .set({ ...values, updatedAt: now })
    .where(eq(units.id, id))
    .returning();
  return toUnit(row);
}

/**
 * Removes a unit nothing hangs off yet: no units below it and no
 * directives, tasks, messages, reports or documents. One with a history is
 * moved or kept, never erased.
 */
export async function deleteUnit(
  id: string,
  database: Database = defaultDb(),
): Promise<void> {
  const all = await listUnits(database);
  findUnit(all, id);
  if (all.some((u) => u.parentId === id)) {
    throw new TreeError(`Move the units under ${id} first`);
  }
  const uses = await Promise.all([
    database
      .select({ id: directives.id })
      .from(directives)
      .where(eq(directives.fromUnit, id))
      .limit(1),
    database
      .select({ id: directiveAssignments.id })
      .from(directiveAssignments)
      .where(eq(directiveAssignments.unitId, id))
      .limit(1),
    database
      .select({ id: unitTasks.id })
      .from(unitTasks)
      .where(eq(unitTasks.unitId, id))
      .limit(1),
    database
      .select({ id: unitMessages.id })
      .from(unitMessages)
      .where(or(eq(unitMessages.fromUnit, id), eq(unitMessages.toUnit, id)))
      .limit(1),
    database
      .select({ id: unitReports.id })
      .from(unitReports)
      .where(eq(unitReports.unitId, id))
      .limit(1),
    database
      .select({ id: unitDocs.id })
      .from(unitDocs)
      .where(eq(unitDocs.unitId, id))
      .limit(1),
  ]);
  if (uses.some((rows) => rows.length)) {
    throw new TreeError(`${id} has a history; move it instead of deleting it`);
  }
  await database.delete(units).where(eq(units.id, id));
}

export async function getUnit(
  id: string,
  database: Database = defaultDb(),
): Promise<Unit | null> {
  const [row] = await database.select().from(units).where(eq(units.id, id));
  return row ? toUnit(row) : null;
}

/** Every unit, siblings in their order. */
export async function listUnits(
  database: Database = defaultDb(),
): Promise<Unit[]> {
  const rows = await database
    .select()
    .from(units)
    .orderBy(asc(units.position), asc(units.name));
  return rows.map(toUnit);
}

/** The unit, or a TreeError naming the id that isn't one. */
export function findUnit(all: Unit[], id: string): Unit {
  const unit = all.find((u) => u.id === id);
  if (!unit) throw new TreeError(`No unit "${id}"`);
  return unit;
}

/** The unit's parent, its parent's, and so on to the root. */
export function ancestors(all: Unit[], id: string): Unit[] {
  const chain: Unit[] = [];
  let at = all.find((u) => u.id === id)?.parentId;
  while (at && !chain.some((u) => u.id === at)) {
    const parent = all.find((u) => u.id === at);
    if (!parent) break;
    chain.push(parent);
    at = parent.parentId;
  }
  return chain;
}

/** Every unit below this one, at any depth. */
export function descendants(all: Unit[], id: string): Unit[] {
  const below: Unit[] = [];
  const walk = (parent: string) => {
    for (const child of all.filter((u) => u.parentId === parent)) {
      below.push(child);
      walk(child.id);
    }
  };
  walk(id);
  return below;
}

/** Who steers the unit: its owner, else the nearest ancestor's. */
export function personOf(all: Unit[], id: string): string | null {
  const unit = all.find((u) => u.id === id);
  if (unit?.owner) return unit.owner;
  return ancestors(all, id).find((u) => u.owner)?.owner ?? null;
}

/** How deep the unit sits: 0 for a root. */
export function depthOf(all: Unit[], id: string): number {
  return ancestors(all, id).length;
}

function toUnit(row: typeof units.$inferSelect): Unit {
  return {
    id: row.id,
    parentId: row.parentId,
    name: row.name,
    summary: row.summary,
    charter: row.charter,
    owner: row.owner,
    mode: row.mode,
    position: row.position,
  };
}
