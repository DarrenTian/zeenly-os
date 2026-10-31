/**
 * Directives: goals and projects that flow over the standing tree for a
 * while. One unit raises a directive; each unit it goes to translates it
 * into its own goal, or says it isn't theirs. Down the tree that's a
 * directive the unit must answer; sideways it's a request a peer may
 * decline. Only the issuer judges it met and closes it, and then every unit
 * packs up its part and goes back to its standing work.
 */

import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { db as defaultDb, type Database } from "../db";
import { directiveAssignments, directives, unitTasks } from "../db/schema";
import { type Actor, actorLabel, requireHuman } from "./actors";
import { appendGuideline } from "./docs";
import { Forbidden, TreeError } from "./errors";
import { write } from "./events";
import {
  descendants,
  findUnit,
  listUnits,
  personOf,
  requireActsFor,
} from "./units";

export type DirectiveStatus = "open" | "done" | "dropped";
export type AssignmentState =
  "new" | "proposed" | "active" | "declined" | "closed";

export type Assignment = {
  id: number;
  directiveId: number;
  unitId: string;
  kind: "directive" | "request";
  state: AssignmentState;
  translation: string | null;
  note: string | null;
  needsConfirm: boolean;
  updatedAt: Date;
};

export type Directive = {
  id: number;
  fromUnit: string;
  parentId: number | null;
  title: string;
  body: string;
  doneWhen: string;
  dueOn: string | null;
  status: DirectiveStatus;
  outcome: string | null;
  createdBy: string;
  createdAt: Date;
  closedAt: Date | null;
  assignments: Assignment[];
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Sends a directive from one unit to others. A unit passing on a directive
 * it received names it as `parentId`. Translations of a root's directive
 * by its own children wait on the root's person to confirm: the first
 * layer's reading of a goal is where alignment is thinnest.
 */
export async function issueDirective(
  input: {
    from: string;
    to: string[];
    title: string;
    body?: string;
    doneWhen: string;
    dueOn?: string | null;
    parentId?: number | null;
  },
  by: Actor,
  { now = new Date() }: { now?: Date } = {},
  database: Database = defaultDb(),
): Promise<Directive> {
  const all = await listUnits(database);
  requireActsFor(all, by, input.from, "issue a directive from it");
  const from = findUnit(all, input.from);
  const to = [...new Set(input.to)];
  if (!to.length)
    throw new TreeError("Send the directive to at least one unit");
  for (const id of to) {
    findUnit(all, id);
    if (id === from.id)
      throw new TreeError("A unit can't send itself a directive");
  }
  const title = input.title.trim();
  const doneWhen = input.doneWhen.trim();
  if (!title) throw new TreeError("Give the directive a title");
  if (!doneWhen)
    throw new TreeError("Say how you'll tell it's done (doneWhen)");
  if (input.dueOn && !DATE.test(input.dueOn)) {
    throw new TreeError("dueOn is a date, YYYY-MM-DD");
  }
  if (input.parentId != null) {
    const parent = await getDirective(input.parentId, database);
    if (!parent) throw new TreeError(`No directive ${input.parentId}`);
    if (parent.status !== "open") {
      throw new TreeError(`Directive ${parent.id} is closed`);
    }
    if (!parent.assignments.some((a) => a.unitId === from.id)) {
      throw new TreeError(
        `${from.id} can only pass on a directive it was sent; directive ${parent.id} wasn't`,
      );
    }
  }

  const below = new Set(descendants(all, from.id).map((u) => u.id));
  return write(
    database,
    by,
    async (tx) => {
      const [row] = await tx
        .insert(directives)
        .values({
          fromUnit: from.id,
          parentId: input.parentId ?? null,
          title,
          body: input.body?.trim() ?? "",
          doneWhen,
          dueOn: input.dueOn || null,
          createdBy: actorLabel(by),
          createdAt: now,
        })
        .returning();
      await tx.insert(directiveAssignments).values(
        to.map((unitId) => ({
          directiveId: row.id,
          unitId,
          kind: below.has(unitId)
            ? ("directive" as const)
            : ("request" as const),
          needsConfirm:
            from.parentId === null &&
            all.find((u) => u.id === unitId)?.parentId === from.id,
          updatedAt: now,
        })),
      );
      return (await getDirective(row.id, tx))!;
    },
    (d) => ({
      what: "directive.issued",
      on: { kind: "directive", id: d.id },
      unit: from.id,
      why: input.parentId != null ? `directive:${input.parentId}` : null,
    }),
    now,
  );
}

/**
 * A unit's reading of a directive: its goal for it, or that it isn't the
 * unit's (`relevant: false`, with why). Translating again replaces the
 * last one, and goes back for confirming if it needs it.
 */
export async function translateDirective(
  input: {
    directive: number;
    unit: string;
    translation?: string;
    relevant?: boolean;
    reason?: string;
  },
  by: Actor,
  { now = new Date() }: { now?: Date } = {},
  database: Database = defaultDb(),
): Promise<Assignment> {
  const all = await listUnits(database);
  requireActsFor(all, by, input.unit, "translate its directive");
  const { directive, assignment } = await assignmentOf(
    input.directive,
    input.unit,
    database,
  );
  if (directive.status !== "open") {
    throw new TreeError(`Directive ${directive.id} is closed`);
  }
  const relevant = input.relevant ?? true;
  if (relevant && !input.translation?.trim()) {
    throw new TreeError("Write the translation: your goal for this directive");
  }
  if (!relevant && !input.reason?.trim()) {
    throw new TreeError("Say why the directive isn't yours (reason)");
  }
  return write(
    database,
    by,
    async (tx) => {
      const [row] = await tx
        .update(directiveAssignments)
        .set(
          relevant
            ? {
                translation: input.translation!.trim(),
                state: assignment.needsConfirm ? "proposed" : "active",
                note: null,
                updatedAt: now,
              }
            : {
                state: "declined",
                note: input.reason!.trim(),
                updatedAt: now,
              },
        )
        .where(eq(directiveAssignments.id, assignment.id))
        .returning();
      return row;
    },
    (after) => ({
      what: relevant ? "directive.translated" : "directive.declined",
      on: { kind: "assignment", id: assignment.id },
      unit: input.unit,
      why: `directive:${directive.id}`,
      before: assignment,
      after,
    }),
    now,
  );
}

/**
 * The issuer's person confirms a proposed translation, or sends it back
 * with a note for the unit to translate again. A send-back is a correction,
 * so the note also becomes a line in the unit's guidelines.
 */
export async function confirmTranslation(
  input: { assignment: number; ok: boolean; note?: string },
  by: Actor,
  { now = new Date() }: { now?: Date } = {},
  database: Database = defaultDb(),
): Promise<Assignment> {
  const person = requireHuman(by, "confirms a translation");
  const [assignment] = await database
    .select()
    .from(directiveAssignments)
    .where(eq(directiveAssignments.id, input.assignment));
  if (!assignment) throw new TreeError(`No assignment ${input.assignment}`);
  if (assignment.state !== "proposed") {
    throw new TreeError("That translation isn't waiting to be confirmed");
  }
  const directive = (await getDirective(assignment.directiveId, database))!;
  const all = await listUnits(database);
  if (personOf(all, directive.fromUnit) !== person) {
    throw new Forbidden(
      `Only ${directive.fromUnit}'s person confirms its directives' translations`,
    );
  }
  const note = input.note?.trim();
  if (!input.ok && !note) {
    throw new TreeError("Say what to change when sending a translation back");
  }
  return write(
    database,
    by,
    async (tx) => {
      const [row] = await tx
        .update(directiveAssignments)
        .set(
          input.ok
            ? { state: "active", note: note || null, updatedAt: now }
            : { state: "new", note: note!, updatedAt: now },
        )
        .where(eq(directiveAssignments.id, assignment.id))
        .returning();
      if (!input.ok) {
        await appendGuideline(
          tx,
          {
            unit: assignment.unitId,
            line: `- ${day(now)} · directive ${directive.id} "${directive.title}": translation sent back: ${note}`,
            reason: `Translation of directive ${directive.id} sent back`,
            why: `directive:${directive.id}`,
          },
          by,
          now,
        );
      }
      return row;
    },
    (after) => ({
      what: input.ok ? "directive.confirmed" : "directive.sent_back",
      on: { kind: "assignment", id: assignment.id },
      unit: assignment.unitId,
      why: `directive:${directive.id}`,
      before: assignment,
      after,
    }),
    now,
  );
}

/**
 * The issuer ends a directive, met or dropped. Every unit's part closes,
 * their tasks for it that nobody started are dropped, and directives
 * passed on from it close with it.
 */
export async function closeDirective(
  input: {
    directive: number;
    unit: string;
    status: "done" | "dropped";
    outcome: string;
  },
  by: Actor,
  { now = new Date() }: { now?: Date } = {},
  database: Database = defaultDb(),
): Promise<Directive> {
  const all = await listUnits(database);
  requireActsFor(all, by, input.unit, "close its directive");
  const directive = await getDirective(input.directive, database);
  if (!directive) throw new TreeError(`No directive ${input.directive}`);
  if (directive.fromUnit !== input.unit) {
    throw new TreeError(
      `Only ${directive.fromUnit}, which issued directive ${directive.id}, closes it`,
    );
  }
  if (directive.status !== "open") {
    throw new TreeError(`Directive ${directive.id} is closed already`);
  }
  const outcome = input.outcome.trim();
  if (!outcome) throw new TreeError("Say how it ended (outcome)");
  return write(
    database,
    by,
    async (tx) => {
      const close = async (id: number, why: string) => {
        await tx
          .update(directives)
          .set({ status: input.status, outcome: why, closedAt: now })
          .where(eq(directives.id, id));
        await tx
          .update(directiveAssignments)
          .set({ state: "closed", updatedAt: now })
          .where(
            and(
              eq(directiveAssignments.directiveId, id),
              inArray(directiveAssignments.state, [
                "new",
                "proposed",
                "active",
              ]),
            ),
          );
        await tx
          .update(unitTasks)
          .set({ status: "dropped", updatedAt: now })
          .where(
            and(eq(unitTasks.directiveId, id), eq(unitTasks.status, "open")),
          );
        const passedOn = await tx
          .select({ id: directives.id })
          .from(directives)
          .where(
            and(eq(directives.parentId, id), eq(directives.status, "open")),
          );
        for (const child of passedOn) {
          await close(
            child.id,
            `Closed with directive ${directive.id}: ${outcome}`,
          );
        }
      };
      await close(directive.id, outcome);
      return (await getDirective(directive.id, tx))!;
    },
    (after) => ({
      what: "directive.closed",
      on: { kind: "directive", id: directive.id },
      unit: input.unit,
      why: `directive:${directive.id}`,
      before: { status: directive.status },
      after: { status: after.status, outcome: after.outcome },
    }),
    now,
  );
}

export async function getDirective(
  id: number,
  database: Database = defaultDb(),
): Promise<Directive | null> {
  const [row] = await database
    .select()
    .from(directives)
    .where(eq(directives.id, id));
  if (!row) return null;
  const assignments = await database
    .select()
    .from(directiveAssignments)
    .where(eq(directiveAssignments.directiveId, id))
    .orderBy(asc(directiveAssignments.id));
  return { ...row, assignments };
}

/** Directives newest first, open ones only unless `all`. */
export async function listDirectives(
  { all = false }: { all?: boolean } = {},
  database: Database = defaultDb(),
): Promise<Directive[]> {
  const rows = await database
    .select()
    .from(directives)
    .where(all ? undefined : eq(directives.status, "open"))
    .orderBy(desc(directives.id));
  if (!rows.length) return [];
  const assignments = await database
    .select()
    .from(directiveAssignments)
    .where(
      inArray(
        directiveAssignments.directiveId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(directiveAssignments.id));
  return rows.map((row) => ({
    ...row,
    assignments: assignments.filter((a) => a.directiveId === row.id),
  }));
}

/** The directives passed on from this one, and theirs, as one list. */
export async function directiveChain(
  id: number,
  database: Database = defaultDb(),
): Promise<Directive[]> {
  const found: Directive[] = [];
  const walk = async (parent: number) => {
    const children = await database
      .select({ id: directives.id })
      .from(directives)
      .where(eq(directives.parentId, parent))
      .orderBy(asc(directives.id));
    for (const child of children) {
      found.push((await getDirective(child.id, database))!);
      await walk(child.id);
    }
  };
  await walk(id);
  return found;
}

async function assignmentOf(
  directiveId: number,
  unitId: string,
  database: Database,
): Promise<{ directive: Directive; assignment: Assignment }> {
  const directive = await getDirective(directiveId, database);
  if (!directive) throw new TreeError(`No directive ${directiveId}`);
  const assignment = directive.assignments.find((a) => a.unitId === unitId);
  if (!assignment) {
    throw new TreeError(`Directive ${directiveId} wasn't sent to ${unitId}`);
  }
  return { directive, assignment };
}

function day(now: Date): string {
  return now.toISOString().slice(0, 10);
}
