/**
 * A company as one file: its tree, its units' documents and capabilities,
 * and the directives, tasks, messages, reports and events on it. Export one
 * to back it up or move it to another install; import it into an empty
 * database to carry on where it was. Ids of directives, tasks, messages and
 * reports are kept, so "directive 3" and a report's citations still point
 * where they did. Tokens never leave: each install mints its own.
 */

import { asc, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { db as defaultDb, type Database } from "../db";
import {
  directiveAssignments,
  directives,
  events,
  unitCapabilities,
  unitDocs,
  unitMessages,
  unitReports,
  units,
  unitTasks,
} from "../db/schema";
import { type Actor } from "./actors";
import { TreeError } from "./errors";
import { record, write } from "./events";

export const BUNDLE_FORMAT = "zeenly-os.company/1";

const date = z.coerce.date();
const actor = z.string().min(1);
const line = z.object({ text: z.string(), cites: z.array(z.number().int()) });

const unit = z.object({
  id: z.string().min(1),
  parentId: z.string().nullable(),
  name: z.string(),
  summary: z.string(),
  owner: z.string().nullable(),
  mode: z.enum(["steer", "autopilot"]),
  position: z.number().int(),
  createdAt: date,
  updatedAt: date,
});

const doc = z.object({
  unitId: z.string(),
  name: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
  version: z.number().int().positive(),
  body: z.string(),
  author: actor,
  reason: z.string(),
  createdAt: date,
});

const capability = z.object({
  unitId: z.string(),
  tool: z.string().min(1),
  scope: z.string(),
  level: z.enum(["root", "parent", "self"]),
  approvals: z.number().int(),
  createdAt: date,
});

const directive = z.object({
  id: z.number().int().positive(),
  fromUnit: z.string(),
  parentId: z.number().int().nullable(),
  title: z.string(),
  body: z.string(),
  doneWhen: z.string(),
  dueOn: z.string().nullable(),
  status: z.enum(["open", "done", "dropped"]),
  outcome: z.string().nullable(),
  createdBy: actor,
  createdAt: date,
  closedAt: date.nullable(),
});

const assignment = z.object({
  directiveId: z.number().int(),
  unitId: z.string(),
  kind: z.enum(["directive", "request"]),
  state: z.enum(["new", "proposed", "active", "declined", "closed"]),
  translation: z.string().nullable(),
  note: z.string().nullable(),
  needsConfirm: z.boolean(),
  updatedAt: date,
});

const task = z.object({
  id: z.number().int().positive(),
  unitId: z.string(),
  title: z.string(),
  detail: z.string(),
  priority: z.number().int(),
  status: z.enum(["open", "doing", "done", "dropped"]),
  directiveId: z.number().int().nullable(),
  source: actor,
  claimedBy: z.string().nullable(),
  prUrl: z.string().nullable(),
  pinned: z.boolean(),
  createdAt: date,
  updatedAt: date,
});

const message = z.object({
  id: z.number().int().positive(),
  kind: z.enum(["request", "escalation", "note"]),
  fromUnit: z.string(),
  toUnit: z.string(),
  path: z.array(z.string()),
  forPerson: z.boolean(),
  subject: z.string(),
  body: z.string(),
  directiveId: z.number().int().nullable(),
  status: z.enum(["open", "resolved", "declined"]),
  resolution: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  sentBy: actor,
  createdAt: date,
  resolvedAt: date.nullable(),
});

const report = z.object({
  id: z.number().int().positive(),
  unitId: z.string(),
  directiveId: z.number().int().nullable(),
  status: z.enum(["ok", "risk", "stuck", "idle"]),
  headline: line,
  done: z.array(line),
  blocked: z.array(line),
  next: z.array(line),
  numbers: z.array(
    z.object({
      name: z.string(),
      value: z.number(),
      target: z.number().optional(),
    }),
  ),
  author: actor,
  createdAt: date,
});

const event = z.object({
  at: date,
  actorKind: z.enum(["unit", "human", "system"]),
  actorId: z.string(),
  what: z.string(),
  onKind: z.string(),
  onId: z.string(),
  unitId: z.string().nullable(),
  why: z.string().nullable(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});

export const companyBundle = z.object({
  format: z.literal(BUNDLE_FORMAT),
  exportedAt: date,
  /** The company's root unit. */
  root: z.string().min(1),
  units: z.array(unit).min(1),
  docs: z.array(doc).default([]),
  capabilities: z.array(capability).default([]),
  directives: z.array(directive).default([]),
  assignments: z.array(assignment).default([]),
  tasks: z.array(task).default([]),
  messages: z.array(message).default([]),
  reports: z.array(report).default([]),
  events: z.array(event).default([]),
});

export type CompanyBundle = z.infer<typeof companyBundle>;

/** How many of each a bundle holds, for the command line and the import's event. */
export function bundleCounts(bundle: CompanyBundle): Record<string, number> {
  return {
    units: bundle.units.length,
    docs: bundle.docs.length,
    capabilities: bundle.capabilities.length,
    directives: bundle.directives.length,
    assignments: bundle.assignments.length,
    tasks: bundle.tasks.length,
    messages: bundle.messages.length,
    reports: bundle.reports.length,
    events: bundle.events.length,
  };
}

/**
 * The company under `root`: that unit and every unit below it, and what is
 * theirs. A directive is the company's when one of its units issued it; a
 * message when it went between two of them.
 */
export async function exportCompany(
  root: string,
  database: Database = defaultDb(),
  now: Date = new Date(),
): Promise<CompanyBundle> {
  const all = await database.select().from(units);
  if (!all.some((u) => u.id === root)) throw new TreeError(`No unit ${root}`);
  const ids = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const u of all) {
      if (u.parentId && ids.has(u.parentId) && !ids.has(u.id)) {
        ids.add(u.id);
        grew = true;
      }
    }
  }
  const unitIds = [...ids];
  const mine = <T extends { unitId: string | null }>(rows: T[]) =>
    rows.filter((r) => r.unitId !== null && ids.has(r.unitId));

  const directiveRows = (
    await database.select().from(directives).orderBy(asc(directives.id))
  ).filter((d) => ids.has(d.fromUnit));
  const directiveIds = new Set(directiveRows.map((d) => d.id));
  const ours = (id: number | null) =>
    id !== null && directiveIds.has(id) ? id : null;

  const [docs, capabilities, assignments, tasks, messages, reports, log] =
    await Promise.all([
      database.select().from(unitDocs).where(inArray(unitDocs.unitId, unitIds)),
      database
        .select()
        .from(unitCapabilities)
        .where(inArray(unitCapabilities.unitId, unitIds)),
      database
        .select()
        .from(directiveAssignments)
        .where(inArray(directiveAssignments.unitId, unitIds)),
      database
        .select()
        .from(unitTasks)
        .where(inArray(unitTasks.unitId, unitIds))
        .orderBy(asc(unitTasks.id)),
      database.select().from(unitMessages).orderBy(asc(unitMessages.id)),
      database
        .select()
        .from(unitReports)
        .where(inArray(unitReports.unitId, unitIds))
        .orderBy(asc(unitReports.id)),
      database.select().from(events).orderBy(asc(events.id)),
    ]);

  // Parsing drops what doesn't travel, such as the ids of rows nothing cites.
  return companyBundle.parse({
    format: BUNDLE_FORMAT,
    exportedAt: now,
    root,
    // A subtree exported on its own becomes a company of its own.
    units: all
      .filter((u) => ids.has(u.id))
      .map((u) => (u.id === root ? { ...u, parentId: null } : u)),
    docs,
    capabilities,
    directives: directiveRows.map((d) => ({
      ...d,
      parentId: ours(d.parentId),
    })),
    assignments: assignments.filter((a) => directiveIds.has(a.directiveId)),
    tasks: tasks.map((t) => ({ ...t, directiveId: ours(t.directiveId) })),
    messages: messages
      .filter((m) => ids.has(m.fromUnit) && ids.has(m.toUnit))
      .map((m) => ({
        ...m,
        path: m.path.filter((p) => ids.has(p)),
        directiveId: ours(m.directiveId),
      })),
    reports: reports.map((r) => ({ ...r, directiveId: ours(r.directiveId) })),
    // Token events name tokens that don't travel with the company.
    events: mine(log).filter((e) => e.onKind !== "token"),
  });
}

/**
 * Loads a bundle into a database with no units yet, in one transaction:
 * all of it or none. Its events come along, and the import adds one for
 * each unit and one for the whole, by `by`.
 */
export async function importCompany(
  input: unknown,
  by: Actor,
  database: Database = defaultDb(),
  now: Date = new Date(),
): Promise<Record<string, number>> {
  const parsed = companyBundle.safeParse(input);
  if (!parsed.success) {
    throw new TreeError(
      `Not a ${BUNDLE_FORMAT} file: ${parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  const bundle = parsed.data;
  checkReferences(bundle);
  const counts = bundleCounts(bundle);

  return write(
    database,
    by,
    async (tx) => {
      const [existing] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(units);
      if (existing.n > 0) {
        throw new TreeError(
          "This database already has a company; import into an empty one",
        );
      }
      // The company's history first, so the import reads as its latest event.
      await many(bundle.events, (r) =>
        tx.insert(events).values(
          r.map((e) => ({
            ...e,
            before: e.before ?? null,
            after: e.after ?? null,
          })),
        ),
      );
      for (const u of parentsFirst(bundle.units)) {
        await tx.insert(units).values(u);
        await record(
          tx,
          by,
          { what: "unit.imported", on: { kind: "unit", id: u.id }, unit: u.id },
          now,
        );
      }
      await many(bundle.docs, (r) => tx.insert(unitDocs).values(r));
      await many(bundle.capabilities, (r) =>
        tx.insert(unitCapabilities).values(r),
      );
      for (const d of parentDirectivesFirst(bundle.directives)) {
        await tx.insert(directives).overridingSystemValue().values(d);
      }
      await many(bundle.assignments, (r) =>
        tx.insert(directiveAssignments).values(r),
      );
      await many(bundle.tasks, (r) =>
        tx.insert(unitTasks).overridingSystemValue().values(r),
      );
      await many(bundle.messages, (r) =>
        tx.insert(unitMessages).overridingSystemValue().values(r),
      );
      await many(bundle.reports, (r) =>
        tx.insert(unitReports).overridingSystemValue().values(r),
      );
      // Kept ids leave the sequences behind; the next new row follows them.
      for (const table of [
        "directives",
        "unit_tasks",
        "unit_messages",
        "unit_reports",
      ]) {
        await tx.execute(
          sql.raw(
            `select setval(pg_get_serial_sequence('${table}', 'id'), coalesce(max(id), 1), max(id) is not null) from ${table}`,
          ),
        );
      }
      return counts;
    },
    () => ({
      what: "company.imported",
      on: { kind: "unit", id: bundle.root },
      unit: bundle.root,
    }),
    now,
  );
}

/** One insert for all of `rows`; an insert of none is an error in SQL. */
async function many<T>(
  rows: T[],
  insert: (rows: T[]) => Promise<unknown>,
): Promise<void> {
  if (rows.length > 0) await insert(rows);
}

/** Everything a row points at is in the bundle, so the import can't half-fail on a reference. */
function checkReferences(bundle: CompanyBundle): void {
  const unitIds = new Set(bundle.units.map((u) => u.id));
  const directiveIds = new Set(bundle.directives.map((d) => d.id));
  const problems: string[] = [];
  const unitRef = (where: string, id: string | null) => {
    if (id !== null && !unitIds.has(id))
      problems.push(`${where}: no unit ${id}`);
  };
  const directiveRef = (where: string, id: number | null) => {
    if (id !== null && !directiveIds.has(id)) {
      problems.push(`${where}: no directive ${id}`);
    }
  };
  if (!unitIds.has(bundle.root)) problems.push(`root: no unit ${bundle.root}`);
  for (const u of bundle.units) unitRef(`unit ${u.id}`, u.parentId);
  for (const d of bundle.docs) unitRef(`doc ${d.name}`, d.unitId);
  for (const c of bundle.capabilities)
    unitRef(`capability ${c.tool}`, c.unitId);
  for (const d of bundle.directives) {
    unitRef(`directive ${d.id}`, d.fromUnit);
    directiveRef(`directive ${d.id}`, d.parentId);
  }
  for (const a of bundle.assignments) {
    unitRef(`assignment of ${a.directiveId}`, a.unitId);
    directiveRef(`assignment`, a.directiveId);
  }
  for (const t of bundle.tasks) {
    unitRef(`task ${t.id}`, t.unitId);
    directiveRef(`task ${t.id}`, t.directiveId);
  }
  for (const m of bundle.messages) {
    unitRef(`message ${m.id}`, m.fromUnit);
    unitRef(`message ${m.id}`, m.toUnit);
    directiveRef(`message ${m.id}`, m.directiveId);
  }
  for (const r of bundle.reports) {
    unitRef(`report ${r.id}`, r.unitId);
    directiveRef(`report ${r.id}`, r.directiveId);
  }
  if (problems.length > 0) {
    throw new TreeError(
      `The file points at things it doesn't hold: ${problems.slice(0, 5).join("; ")}`,
    );
  }
}

function parentsFirst<T extends { id: string; parentId: string | null }>(
  rows: T[],
): T[] {
  return order(
    rows,
    (r) => r.id,
    (r) => r.parentId,
  );
}

function parentDirectivesFirst<
  T extends { id: number; parentId: number | null },
>(rows: T[]): T[] {
  return order(
    rows,
    (r) => r.id,
    (r) => r.parentId,
  );
}

/** Each row after the one it names as parent; a cycle is refused. */
function order<T, K>(
  rows: T[],
  key: (r: T) => K,
  parent: (r: T) => K | null,
): T[] {
  const placed = new Set<K>();
  const out: T[] = [];
  let left = rows;
  while (left.length > 0) {
    const ready = left.filter((r) => {
      const p = parent(r);
      return p === null || placed.has(p) || !rows.some((o) => key(o) === p);
    });
    if (ready.length === 0)
      throw new TreeError("The file's parents form a cycle");
    for (const r of ready) {
      placed.add(key(r));
      out.push(r);
    }
    left = left.filter((r) => !ready.includes(r));
  }
  return out;
}
