/**
 * A unit's documents: what the role keeps and its agent reads first. Two
 * names carry meaning. `handbook` is how the role does its work, including
 * what went wrong before; `guidelines` is what the unit's person decided when
 * they overruled it, one line each, and the only way the tree learns. A unit
 * may keep others (a style guide, notes). Every save adds a version with an
 * author and a reason, so a change can be read back and undone. The charter
 * (what the unit owns) is a column on the unit itself.
 */

import { and, desc, eq } from "drizzle-orm";

import { db as defaultDb, type Database } from "../db";
import { unitDocs } from "../db/schema";
import { findUnit, listUnits, TreeError } from "./units";

export const DOC_NAMES = ["handbook", "guidelines"] as const;

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
  const unit = findUnit(await listUnits(database), input.unit);
  const [row] = await database
    .select()
    .from(unitDocs)
    .where(
      and(
        eq(unitDocs.unitId, unit.id),
        eq(unitDocs.name, input.name),
        input.version ? eq(unitDocs.version, input.version) : undefined,
      ),
    )
    .orderBy(desc(unitDocs.version))
    .limit(1);
  return row
    ? {
        name: row.name,
        version: row.version,
        author: row.author,
        updatedAt: row.createdAt,
        body: row.body,
        reason: row.reason,
      }
    : null;
}

/**
 * Saves `body` as the document's next version. `baseVersion` is the version
 * the change was made on (0 for a new one); if someone saved since, this
 * throws DocConflictError. Saving the same text again adds nothing.
 */
export async function saveUnitDoc(
  input: {
    unit: string;
    name: string;
    body: string;
    baseVersion: number;
    author: string;
    reason: string;
  },
  database: Database = defaultDb(),
): Promise<{ version: number }> {
  const unit = findUnit(await listUnits(database), input.unit);
  if (!input.body.trim()) throw new TreeError("Don't save an empty document");
  if (!input.reason.trim()) throw new TreeError("Say why it changed (reason)");
  if (!NAME.test(input.name)) {
    throw new TreeError(
      "A document's name is 2–40 lower-case letters, digits and dashes, starting with a letter",
    );
  }
  const latest = await getUnitDoc(
    { unit: unit.id, name: input.name },
    database,
  );
  const at = latest?.version ?? 0;
  if (input.baseVersion !== at) throw new DocConflictError(input.name, at);
  if (latest && latest.body === input.body) return { version: at };
  try {
    await database.insert(unitDocs).values({
      unitId: unit.id,
      name: input.name,
      version: at + 1,
      body: input.body,
      author: input.author,
      reason: input.reason.trim(),
    });
  } catch {
    // Someone saved the same version a moment before: the unique index.
    const now = await getUnitDoc({ unit: unit.id, name: input.name }, database);
    throw new DocConflictError(input.name, now?.version ?? at);
  }
  return { version: at + 1 };
}
