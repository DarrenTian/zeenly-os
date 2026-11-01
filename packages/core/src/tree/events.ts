/**
 * The one way the tree changes. `write` runs a change in a transaction and
 * appends the event that describes it in the same transaction, so every
 * change the tables show has a line here saying who made it, to what, and
 * why. Nothing replays events; they are the record: a unit's activity
 * stream, and later the signals the tree evolves on.
 */

import { and, desc, eq, lt } from "drizzle-orm";

import { checkSchema, db as defaultDb, type Database } from "../db";
import { events } from "../db/schema";
import type { Actor } from "./actors";
import { SchemaBehind } from "./errors";

export type Event = typeof events.$inferSelect;

export type Change = {
  /** "directive.issued", "message.resolved", "doc.saved", … */
  what: string;
  /** What changed, as a kind and an id. */
  on: { kind: string; id: string | number };
  /** The unit the change is about, for its activity stream. */
  unit?: string | null;
  /** What it served: "directive:12", "message:7". */
  why?: string | null;
  before?: unknown;
  /** Defaults to what `apply` returned. */
  after?: unknown;
};

/** Appends one event on `tx`. Writes that span several rows call this once per thing that changed. */
export async function record(
  tx: Database,
  actor: Actor,
  change: Change,
  now: Date,
): Promise<Event> {
  const [row] = await tx
    .insert(events)
    .values({
      at: now,
      actorKind: actor.kind,
      actorId: actor.id,
      what: change.what,
      onKind: change.on.kind,
      onId: String(change.on.id),
      unitId: change.unit ?? null,
      why: change.why ?? null,
      before: change.before ?? null,
      after: change.after ?? null,
    })
    .returning();
  return row;
}

/**
 * Runs `apply` in a transaction and records the event `change` names for
 * what it returned. A change that fails leaves no event; an event is never
 * written without its change.
 */
export async function write<T>(
  database: Database,
  actor: Actor,
  apply: (tx: Database) => Promise<T>,
  change: (after: T) => Change,
  now: Date = new Date(),
): Promise<T> {
  await assertWritable(database);
  return database.transaction(async (tx) => {
    const after = await apply(tx);
    const named = change(after);
    await record(tx, actor, { ...named, after: named.after ?? after }, now);
    return after;
  });
}

// Databases found up to date. A database only moves forward, so once it is
// it stays so for this process; one found behind is asked again on the next
// write, so writes resume as soon as `zeenly-os migrate` has run.
const writable = new WeakSet<Database>();

/**
 * Refuses to write to a database that hasn't had every migration this code
 * needs: code writing columns that aren't there yet would fail halfway or
 * worse. A database ahead of the code is fine: migrations only add until
 * no running version needs what they remove (see CLAUDE.md, Migrations).
 */
async function assertWritable(database: Database): Promise<void> {
  if (writable.has(database)) return;
  const status = await checkSchema(database);
  if (status.state === "behind") {
    throw new SchemaBehind(
      `The database is behind the code (missing ${status.missing.join(", ")}), so nothing can be written until it's migrated: run \`zeenly-os migrate\`.`,
    );
  }
  writable.add(database);
}

/** Events newest first: a unit's, or everyone's; `before` an id pages back. */
export async function listEvents(
  {
    unit,
    limit = 50,
    before,
  }: { unit?: string; limit?: number; before?: number } = {},
  database: Database = defaultDb(),
): Promise<Event[]> {
  return database
    .select()
    .from(events)
    .where(
      and(
        unit ? eq(events.unitId, unit) : undefined,
        before ? lt(events.id, before) : undefined,
      ),
    )
    .orderBy(desc(events.id))
    .limit(limit);
}
