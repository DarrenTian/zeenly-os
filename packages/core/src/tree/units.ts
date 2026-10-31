/**
 * The function tree's units: standing roles, each with a charter, a person
 * who steers it and a mode. Everything else in the tree (directives, tasks,
 * messages, reports, documents) hangs off a unit. Who may act as a unit is
 * decided here too: its own agent, or the person who steers it.
 */

import { asc, eq, or } from "drizzle-orm";

import { db as defaultDb, type Database } from "../db";
import {
  directiveAssignments,
  directives,
  unitCapabilities,
  unitDocs,
  unitMessages,
  unitReports,
  units,
  unitTasks,
} from "../db/schema";
import { type Actor, actorLabel, requireHuman } from "./actors";
import { Forbidden, TreeError } from "./errors";
import { write } from "./events";

export { Forbidden, TreeError } from "./errors";

export type UnitMode = "steer" | "autopilot";

export type Unit = {
  id: string;
  parentId: string | null;
  name: string;
  summary: string;
  owner: string | null;
  mode: UnitMode;
  position: number;
};

const SLUG = /^[a-z][a-z0-9-]{1,39}$/;

/**
 * A person adds a unit: a new root (which they then steer), or a child under
 * a unit they steer. The charter, if given, is the unit's first document.
 */
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
  by: Actor,
  { now = new Date() }: { now?: Date } = {},
  database: Database = defaultDb(),
): Promise<Unit> {
  const person = requireHuman(by, "adds a unit");
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
  if (parentId) {
    findUnit(all, parentId);
    if (personOf(all, parentId) !== person) {
      throw new Forbidden(`Only ${parentId}'s person adds units under it`);
    }
  }
  const position =
    Math.max(
      -1,
      ...all.filter((u) => u.parentId === parentId).map((u) => u.position),
    ) + 1;
  const charter = input.charter?.trim() ?? "";
  return write(
    database,
    by,
    async (tx) => {
      const [row] = await tx
        .insert(units)
        .values({
          id: input.id,
          parentId,
          name,
          summary,
          // A root with no owner would leave its escalations with nobody.
          owner: input.owner ?? (parentId ? null : person),
          mode: input.mode ?? "steer",
          position,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (charter) {
        await tx.insert(unitDocs).values({
          unitId: row.id,
          name: "charter",
          version: 1,
          body: charter,
          author: actorLabel(by),
          reason: "Created with the unit",
          createdAt: now,
        });
      }
      return toUnit(row);
    },
    (unit) => ({
      what: "unit.created",
      on: { kind: "unit", id: unit.id },
      unit: unit.id,
      after: { ...unit, charter },
    }),
    now,
  );
}

/**
 * The unit's person changes what's given; moving it needs them to steer the
 * new parent too, and a unit never sits under its own subtree.
 */
export async function updateUnit(
  id: string,
  patch: {
    name?: string;
    summary?: string;
    owner?: string | null;
    mode?: UnitMode;
    parentId?: string | null;
    /** Its place among its siblings, smallest first. */
    position?: number;
  },
  by: Actor,
  { now = new Date() }: { now?: Date } = {},
  database: Database = defaultDb(),
): Promise<Unit> {
  const person = requireHuman(by, "changes a unit");
  const all = await listUnits(database);
  const unit = findUnit(all, id);
  if (personOf(all, id) !== person) {
    throw new Forbidden(`Only ${id}'s person changes it`);
  }
  if (patch.parentId !== undefined && patch.parentId !== null) {
    findUnit(all, patch.parentId);
    if (
      patch.parentId === id ||
      ancestors(all, patch.parentId).some((u) => u.id === id)
    ) {
      throw new TreeError(`"${id}" can't sit under its own subtree`);
    }
    if (personOf(all, patch.parentId) !== person) {
      throw new Forbidden(
        `Only ${patch.parentId}'s person moves units under it`,
      );
    }
  }
  // A root without a person would leave its escalations with nobody: the
  // person moving it there steers it.
  const nextParent =
    patch.parentId !== undefined ? patch.parentId : unit.parentId;
  const nextOwner = patch.owner !== undefined ? patch.owner : unit.owner;
  const orphan = nextParent === null && nextOwner === null;
  const values = {
    ...(patch.name?.trim() && { name: patch.name.trim() }),
    ...(patch.summary?.trim() && { summary: patch.summary.trim() }),
    ...(patch.owner !== undefined && { owner: patch.owner }),
    ...(orphan && { owner: person }),
    ...(patch.mode && { mode: patch.mode }),
    ...(patch.parentId !== undefined && { parentId: patch.parentId }),
    ...(patch.position !== undefined && { position: patch.position }),
  };
  if (!Object.keys(values).length) return unit;
  return write(
    database,
    by,
    async (tx) => {
      const [row] = await tx
        .update(units)
        .set({ ...values, updatedAt: now })
        .where(eq(units.id, id))
        .returning();
      return toUnit(row);
    },
    (after) => ({
      what: "unit.updated",
      on: { kind: "unit", id },
      unit: id,
      before: unit,
      after,
    }),
    now,
  );
}

/**
 * Removes a unit nothing hangs off yet: no units below it and no
 * directives, tasks, messages, reports, documents or capabilities. One with
 * a history is moved or kept, never erased.
 */
export async function deleteUnit(
  id: string,
  by: Actor,
  { now = new Date() }: { now?: Date } = {},
  database: Database = defaultDb(),
): Promise<void> {
  const person = requireHuman(by, "removes a unit");
  const all = await listUnits(database);
  const unit = findUnit(all, id);
  if (personOf(all, id) !== person) {
    throw new Forbidden(`Only ${id}'s person removes it`);
  }
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
    database
      .select({ id: unitCapabilities.id })
      .from(unitCapabilities)
      .where(eq(unitCapabilities.unitId, id))
      .limit(1),
  ]);
  if (uses.some((rows) => rows.length)) {
    throw new TreeError(`${id} has a history; move it instead of deleting it`);
  }
  await write(
    database,
    by,
    async (tx) => {
      await tx.delete(units).where(eq(units.id, id));
      return { id };
    },
    () => ({
      what: "unit.deleted",
      on: { kind: "unit", id },
      unit: id,
      before: unit,
    }),
    now,
  );
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

/**
 * Whether `actor` may act as `unit`: the unit's own agent, or the person
 * who steers it. The system acts as no unit.
 */
export function actsFor(all: Unit[], actor: Actor, unit: string): boolean {
  if (actor.kind === "unit") return actor.id === unit;
  if (actor.kind === "human") return personOf(all, unit) === actor.id;
  return false;
}

/** Forbidden, with who may, unless `actor` acts for `unit`. */
export function requireActsFor(
  all: Unit[],
  actor: Actor,
  unit: string,
  doing: string,
): void {
  findUnit(all, unit);
  if (!actsFor(all, actor, unit)) {
    throw new Forbidden(
      `${actorLabel(actor)} doesn't act for ${unit}, so it can't ${doing}; its agent or its person does`,
    );
  }
}

function toUnit(row: typeof units.$inferSelect): Unit {
  return {
    id: row.id,
    parentId: row.parentId,
    name: row.name,
    summary: row.summary,
    owner: row.owner,
    mode: row.mode,
    position: row.position,
  };
}
