/**
 * What a unit may use outside the tree: a tool, narrowed by a scope, at an
 * approval level. A unit's capabilities are a subset of its parent's, so a
 * person grants a child only what the parent already has, and taking one
 * from a unit takes it from everything below. The command that runs a unit's
 * agent reads this list and connects nothing else.
 */

import { and, eq, inArray } from "drizzle-orm";

import { db as defaultDb, type Database } from "../db";
import { unitCapabilities } from "../db/schema";
import { type Actor, requireHuman } from "./actors";
import { Forbidden, TreeError } from "./errors";
import { write } from "./events";
import { descendants, findUnit, listUnits, personOf, type Unit } from "./units";

export type CapabilityLevel = "root" | "parent" | "self";
export type Capability = typeof unitCapabilities.$inferSelect;

/** The person who grants a unit's capabilities: its parent's, or its own for a root. */
function granterOf(all: Unit[], unit: Unit): string | null {
  return personOf(all, unit.parentId ?? unit.id);
}

/**
 * Gives a unit a tool, or changes the level of one it has. For a child, the
 * parent must have the tool with the same scope or with no scope at all.
 */
export async function grantCapability(
  input: {
    unit: string;
    tool: string;
    scope?: string;
    level?: CapabilityLevel;
  },
  by: Actor,
  { now = new Date() }: { now?: Date } = {},
  database: Database = defaultDb(),
): Promise<Capability> {
  const person = requireHuman(by, "grants capabilities");
  const all = await listUnits(database);
  const unit = findUnit(all, input.unit);
  if (granterOf(all, unit) !== person) {
    throw new Forbidden(
      `Only the person steering ${unit.parentId ?? unit.id} grants ${unit.id} capabilities`,
    );
  }
  const tool = input.tool.trim();
  const scope = input.scope?.trim() ?? "";
  if (!tool) throw new TreeError("Name the tool");
  if (unit.parentId) {
    const parents = await listCapabilities(unit.parentId, database);
    const covered = parents.some(
      (c) => c.tool === tool && (c.scope === "" || c.scope === scope),
    );
    if (!covered) {
      throw new TreeError(
        `${unit.parentId} doesn't have ${describe(tool, scope)}, so ${unit.id} can't: a unit's capabilities are a subset of its parent's`,
      );
    }
  }
  const level = input.level ?? "root";
  const before = (await listCapabilities(unit.id, database)).find(
    (c) => c.tool === tool && c.scope === scope,
  );
  return write(
    database,
    by,
    async (tx) => {
      const [row] = await tx
        .insert(unitCapabilities)
        .values({ unitId: unit.id, tool, scope, level, createdAt: now })
        .onConflictDoUpdate({
          target: [
            unitCapabilities.unitId,
            unitCapabilities.tool,
            unitCapabilities.scope,
          ],
          set: { level },
        })
        .returning();
      return row;
    },
    (row) => ({
      what: before ? "capability.changed" : "capability.granted",
      on: { kind: "capability", id: row.id },
      unit: unit.id,
      before: before ?? null,
    }),
    now,
  );
}

/**
 * Takes a tool from a unit and, since theirs are subsets of its, from every
 * unit below it that holds the tool within that scope. With no scope named,
 * every scope of the tool goes.
 */
export async function revokeCapability(
  input: { unit: string; tool: string; scope?: string },
  by: Actor,
  { now = new Date() }: { now?: Date } = {},
  database: Database = defaultDb(),
): Promise<{ removed: number }> {
  const person = requireHuman(by, "revokes capabilities");
  const all = await listUnits(database);
  const unit = findUnit(all, input.unit);
  if (granterOf(all, unit) !== person) {
    throw new Forbidden(
      `Only the person steering ${unit.parentId ?? unit.id} revokes ${unit.id}'s capabilities`,
    );
  }
  const tool = input.tool.trim();
  const scope = input.scope?.trim() ?? "";
  const ids = [unit.id, ...descendants(all, unit.id).map((u) => u.id)];
  const held = await database
    .select()
    .from(unitCapabilities)
    .where(
      and(
        inArray(unitCapabilities.unitId, ids),
        eq(unitCapabilities.tool, tool),
      ),
    );
  // No scope named: every scope of the tool goes, here and below.
  const gone = held.filter((c) => scope === "" || c.scope === scope);
  if (!gone.length) {
    throw new TreeError(`${unit.id} doesn't have ${describe(tool, scope)}`);
  }
  return write(
    database,
    by,
    async (tx) => {
      await tx.delete(unitCapabilities).where(
        inArray(
          unitCapabilities.id,
          gone.map((c) => c.id),
        ),
      );
      return { removed: gone.length };
    },
    () => ({
      what: "capability.revoked",
      on: { kind: "capability", id: `${unit.id}/${describe(tool, scope)}` },
      unit: unit.id,
      before: gone,
    }),
    now,
  );
}

/** A unit's own capabilities, by tool then scope. */
export async function listCapabilities(
  unit: string,
  database: Database = defaultDb(),
): Promise<Capability[]> {
  return database
    .select()
    .from(unitCapabilities)
    .where(eq(unitCapabilities.unitId, unit))
    .orderBy(unitCapabilities.tool, unitCapabilities.scope);
}

function describe(tool: string, scope: string): string {
  return scope ? `${tool} on ${scope}` : tool;
}
