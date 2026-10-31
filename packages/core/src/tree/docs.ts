/**
 * A unit's documents: what the role keeps and its agent reads first. Three
 * names carry meaning. `charter` is what the unit owns and doesn't; its
 * person writes it. `handbook` is how the role does its work, including what
 * went wrong before; the unit's agent keeps it. `guidelines` is what the
 * unit's person decided when they overruled it, one line each, and the only
 * way the tree learns: lines are added when a person decides an escalation
 * or sends a translation back, and only a person edits them. A unit may
 * keep other documents too (a style guide, notes). Every save adds a version
 * with an author and a reason, so a change can be read back and undone.
 */

import { and, desc, eq } from "drizzle-orm";

import { db as defaultDb, type Database } from "../db";
import { unitDocs } from "../db/schema";
import { type Actor, actorLabel, requireHuman } from "./actors";
import { Forbidden, TreeError } from "./errors";
import { record, write } from "./events";
import { findUnit, listUnits, personOf, requireActsFor } from "./units";

export const DOC_NAMES = ["charter", "handbook", "guidelines"] as const;
export type DocName = (typeof DOC_NAMES)[number];

/** Documents only the unit's person writes. */
const PERSONS_DOCS: readonly string[] = ["charter", "guidelines"];

export type UnitDoc = {
  name: string;
  version: number;
  author: string;
  updatedAt: Date;
};

export type UnitDocVersion = UnitDoc & { body: string; reason: string };

/** A save made on top of a version that is no longer the latest. */
export class DocConflictError extends TreeError {
  constructor(
    readonly name: string,
    readonly latest: number,
  ) {
    super(
      `${name} is at version ${latest} now; read it again, redo your change on top and save again`,
    );
  }
}

const NAME = /^[a-z][a-z0-9-]{1,39}$/;

/** Every document the unit has, at its latest version, by name. */
export async function listUnitDocs(
  unitId: string,
  database: Database = defaultDb(),
): Promise<UnitDoc[]> {
  const unit = findUnit(await listUnits(database), unitId);
  const rows = await database
    .selectDistinctOn([unitDocs.name])
    .from(unitDocs)
    .where(eq(unitDocs.unitId, unit.id))
    .orderBy(unitDocs.name, desc(unitDocs.version));
  return rows.map((d) => ({
    name: d.name,
    version: d.version,
    author: d.author,
    updatedAt: d.createdAt,
  }));
}

/** One document as it stands (or at `version`); null if there's none. */
export async function getUnitDoc(
  input: { unit: string; name: string; version?: number },
  database: Database = defaultDb(),
): Promise<UnitDocVersion | null> {
  const [row] = await database
    .select()
    .from(unitDocs)
    .where(
      and(
        eq(unitDocs.unitId, input.unit),
        eq(unitDocs.name, input.name),
        input.version ? eq(unitDocs.version, input.version) : undefined,
      ),
    )
    .orderBy(desc(unitDocs.version))
    .limit(1);
  if (!row) {
    findUnit(await listUnits(database), input.unit);
    return null;
  }
  return {
    name: row.name,
    version: row.version,
    author: row.author,
    updatedAt: row.createdAt,
    body: row.body,
    reason: row.reason,
  };
}

/** The latest body of one document for every unit that has it. */
export async function latestDocBodies(
  name: string,
  database: Database = defaultDb(),
): Promise<Map<string, string>> {
  const rows = await database
    .selectDistinctOn([unitDocs.unitId])
    .from(unitDocs)
    .where(eq(unitDocs.name, name))
    .orderBy(unitDocs.unitId, desc(unitDocs.version));
  return new Map(rows.map((r) => [r.unitId, r.body]));
}

/**
 * Saves `body` as the document's next version. `baseVersion` is the version
 * the change was made on (0 for a new one); if someone saved since, this
 * throws DocConflictError. Saving the same text again adds nothing. The
 * charter and guidelines are the unit's person's; the rest its agent's too.
 */
export async function saveUnitDoc(
  input: {
    unit: string;
    name: string;
    body: string;
    baseVersion: number;
    reason: string;
  },
  by: Actor,
  { now = new Date() }: { now?: Date } = {},
  database: Database = defaultDb(),
): Promise<{ version: number }> {
  const all = await listUnits(database);
  const unit = findUnit(all, input.unit);
  if (PERSONS_DOCS.includes(input.name)) {
    const person = requireHuman(by, `changes a ${input.name}`);
    if (personOf(all, unit.id) !== person) {
      throw new Forbidden(`Only ${unit.id}'s person changes its ${input.name}`);
    }
  } else {
    requireActsFor(all, by, unit.id, `save its ${input.name}`);
  }
  if (!input.body.trim()) throw new TreeError("Don't save an empty document");
  if (!input.reason.trim()) throw new TreeError("Say why it changed (reason)");
  if (!NAME.test(input.name)) {
    throw new TreeError(
      "A document's name is 2–40 lower-case letters, digits and dashes, starting with a letter",
    );
  }
  const saved = await write(
    database,
    by,
    async (tx) => {
      const latest = await getUnitDoc({ unit: unit.id, name: input.name }, tx);
      const at = latest?.version ?? 0;
      if (input.baseVersion !== at) {
        throw new DocConflictError(input.name, at);
      }
      if (latest && latest.body === input.body) {
        return { version: at, previous: at, unchanged: true };
      }
      try {
        await tx.insert(unitDocs).values({
          unitId: unit.id,
          name: input.name,
          version: at + 1,
          body: input.body,
          author: actorLabel(by),
          reason: input.reason.trim(),
          createdAt: now,
        });
      } catch {
        // Someone saved the same version a moment before: the unique index.
        throw new DocConflictError(input.name, at + 1);
      }
      return { version: at + 1, previous: at, unchanged: false };
    },
    (r) => ({
      what: r.unchanged ? "doc.unchanged" : "doc.saved",
      on: { kind: "doc", id: `${unit.id}/${input.name}` },
      unit: unit.id,
      before: r.previous ? { version: r.previous } : null,
      after: {
        name: input.name,
        version: r.version,
        reason: input.reason.trim(),
      },
    }),
    now,
  );
  return { version: saved.version };
}

/**
 * Adds one line to a unit's guidelines, inside the caller's transaction and
 * with its own event: how the tree learns when a person overrules a unit.
 */
export async function appendGuideline(
  tx: Database,
  input: { unit: string; line: string; reason: string; why?: string },
  by: Actor,
  now: Date,
): Promise<number> {
  const latest = await getUnitDoc({ unit: input.unit, name: "guidelines" }, tx);
  const line = input.line.trim();
  const body = latest ? `${latest.body.trimEnd()}\n${line}` : line;
  const version = (latest?.version ?? 0) + 1;
  await tx.insert(unitDocs).values({
    unitId: input.unit,
    name: "guidelines",
    version,
    body,
    author: actorLabel(by),
    reason: input.reason,
    createdAt: now,
  });
  await record(
    tx,
    by,
    {
      what: "doc.saved",
      on: { kind: "doc", id: `${input.unit}/guidelines` },
      unit: input.unit,
      why: input.why ?? null,
      before: latest ? { version: latest.version } : null,
      after: { name: "guidelines", version, reason: input.reason, line },
    },
    now,
  );
  return version;
}
