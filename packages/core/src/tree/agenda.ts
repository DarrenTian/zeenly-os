/**
 * What the tree asks of whom: a unit's view of its own world when its agent
 * runs, which units have something for their agent to do, and what waits on
 * a person (their decision desk).
 */

import { eq, inArray } from "drizzle-orm";

import { db as defaultDb, type Database } from "../db";
import { directiveAssignments, directives } from "../db/schema";
import { listUnitDocs, type UnitDoc } from "./docs";
import { type Assignment, type Directive, listDirectives } from "./directives";
import {
  answers,
  inbox,
  type Message,
  openMessages,
  waitingOnPeople,
} from "./messages";
import {
  latestReports,
  type Report,
  type ReportStatus,
  rollUp,
} from "./reports";
import { listTasks, type Task } from "./tasks";
import {
  ancestors,
  depthOf,
  findUnit,
  listUnits,
  personOf,
  type Unit,
} from "./units";

/** A unit as the tree page and `unit_tree` show it. */
export type TreeNode = {
  unit: Unit;
  depth: number;
  person: string | null;
  /** Worst status in its subtree; null before anyone in it reported. */
  status: ReportStatus | null;
  latest: Report | null;
  openTasks: number;
  inbox: number;
};

/** The whole tree, each unit after its parent, siblings in order. */
export async function treeOverview(
  database: Database = defaultDb(),
): Promise<TreeNode[]> {
  const [all, latest, tasks, open] = await Promise.all([
    listUnits(database),
    latestReports(database),
    listTasks({}, database),
    openMessages(database),
  ]);
  const rolled = rollUp(all, latest);
  const ordered: Unit[] = [];
  const walk = (parent: string | null) => {
    for (const unit of all.filter((u) => u.parentId === parent)) {
      ordered.push(unit);
      walk(unit.id);
    }
  };
  walk(null);
  return ordered.map((unit) => ({
    unit,
    depth: depthOf(all, unit.id),
    person: personOf(all, unit.id),
    status: rolled.get(unit.id) ?? null,
    latest: latest.get(unit.id) ?? null,
    openTasks: tasks.filter((t) => t.unitId === unit.id).length,
    inbox: open.filter((m) => m.toUnit === unit.id).length,
  }));
}

/** A directive as one unit sees it: the directive and its own part. */
export type DirectivePart = {
  directive: Omit<Directive, "assignments">;
  assignment: Assignment;
};

/**
 * Everything one unit's agent reads when it runs: itself and its children
 * in full; its ancestors' charters and open directives; its siblings' and
 * its ancestors' peers' one-line summaries.
 */
export type UnitView = {
  unit: Unit;
  person: string | null;
  ancestors: (Pick<Unit, "id" | "name" | "summary" | "charter" | "mode"> & {
    openDirectives: { id: number; title: string; doneWhen: string }[];
  })[];
  peers: Pick<Unit, "id" | "name" | "summary" | "parentId">[];
  children: (Pick<Unit, "id" | "name" | "summary" | "mode"> & {
    latest: Report | null;
  })[];
  directives: DirectivePart[];
  tasks: Task[];
  inbox: Message[];
  answers: Message[];
  latest: Report | null;
  /** Directives this unit issued that are still open. */
  issued: Directive[];
  /** What it sent that's still open. */
  sent: Message[];
  /** Why its agent was woken now, as unit_pending says. */
  pending: string[];
  /** What it keeps and reads first: handbook, guidelines, its own. */
  docs: UnitDoc[];
};

export async function unitView(
  id: string,
  database: Database = defaultDb(),
): Promise<UnitView> {
  const all = await listUnits(database);
  const unit = findUnit(all, id);
  const [latest, open, tasks, waiting] = await Promise.all([
    latestReports(database),
    listDirectives({}, database),
    listTasks({ unit: id }, database),
    inbox(id, {}, database),
  ]);
  const chain = ancestors(all, id);
  const chainIds = new Set([id, ...chain.map((u) => u.id)]);
  const peers = all.filter(
    (u) =>
      !chainIds.has(u.id) &&
      // Other roots are other trees, not peers.
      u.parentId !== null &&
      (u.parentId === unit.parentId ||
        chain.some((a) => a.parentId === u.parentId)),
  );
  const own = latest.get(id) ?? null;
  return {
    unit,
    person: personOf(all, id),
    ancestors: chain.map((a) => ({
      id: a.id,
      name: a.name,
      summary: a.summary,
      charter: a.charter,
      mode: a.mode,
      openDirectives: open
        .filter((d) =>
          d.assignments.some((p) => p.unitId === a.id && isLive(p)),
        )
        .map((d) => ({ id: d.id, title: d.title, doneWhen: d.doneWhen })),
    })),
    peers: peers.map((u) => ({
      id: u.id,
      name: u.name,
      summary: u.summary,
      parentId: u.parentId,
    })),
    children: all
      .filter((u) => u.parentId === id)
      .map((u) => ({
        id: u.id,
        name: u.name,
        summary: u.summary,
        mode: u.mode,
        latest: latest.get(u.id) ?? null,
      })),
    directives: open.flatMap((d) => {
      const assignment = d.assignments.find((p) => p.unitId === id);
      if (!assignment || assignment.state === "closed") return [];
      return [{ directive: withoutAssignments(d), assignment }];
    }),
    tasks,
    inbox: waiting,
    answers: await answers(id, own?.createdAt ?? null, database),
    latest: own,
    issued: open.filter((d) => d.fromUnit === id),
    sent: (await openMessages(database)).filter((m) => m.fromUnit === id),
    pending:
      (await pendingUnits({}, database)).find((p) => p.unit === id)?.reasons ??
      [],
    docs: await listUnitDocs(id, database),
  };
}

/** A directive without every unit's part, which a unit doesn't need. */
function withoutAssignments(d: Directive): Omit<Directive, "assignments"> {
  const copy: Partial<Directive> = { ...d };
  delete copy.assignments;
  return copy as Omit<Directive, "assignments">;
}

function isLive(a: Assignment): boolean {
  return a.state === "new" || a.state === "proposed" || a.state === "active";
}

/** A unit whose agent has something to do, and what. */
export type PendingUnit = { unit: string; depth: number; reasons: string[] };

/** How long an active unit goes without a report before it's due one. */
const REPORT_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * The units whose agents should run now, deepest first, so a parent's run
 * can cite its children's fresh reports and settle what they escalated in
 * the same pass. A unit with nothing waiting stays asleep (costs nothing).
 */
export async function pendingUnits(
  { now = new Date() }: { now?: Date } = {},
  database: Database = defaultDb(),
): Promise<PendingUnit[]> {
  const all = await listUnits(database);
  const [latest, open, messages] = await Promise.all([
    latestReports(database),
    listDirectives({}, database),
    openMessages(database),
  ]);
  const pending: PendingUnit[] = [];
  for (const unit of all) {
    const reasons: string[] = [];
    const parts = open.flatMap((d) =>
      d.assignments.filter((a) => a.unitId === unit.id).map((a) => ({ d, a })),
    );
    for (const { d, a } of parts) {
      if (a.state === "new") {
        reasons.push(
          a.note
            ? `translate directive ${d.id} again: ${a.note}`
            : `translate directive ${d.id}`,
        );
      }
    }
    const waiting = messages.filter(
      (m) => m.toUnit === unit.id && !m.forPerson,
    );
    if (waiting.length) {
      reasons.push(`answer messages ${waiting.map((m) => m.id).join(", ")}`);
    }
    const own = latest.get(unit.id);
    const settled = await answers(unit.id, own?.createdAt ?? null, database);
    if (settled.length) {
      reasons.push(
        `read answers to messages ${settled.map((m) => m.id).join(", ")}, then report`,
      );
    }
    const active = parts.some(({ a }) => a.state === "active");
    if (
      active &&
      (!own || now.getTime() - own.createdAt.getTime() >= REPORT_EVERY_MS)
    ) {
      reasons.push("report");
    }
    // A child reported since this unit did: its summary is out of date.
    const children = all.filter((u) => u.parentId === unit.id);
    if (
      active &&
      own &&
      children.some((c) => (latest.get(c.id)?.createdAt ?? 0) > own.createdAt)
    ) {
      if (!reasons.includes("report"))
        reasons.push("report: children reported since");
    }
    if (reasons.length) {
      pending.push({ unit: unit.id, depth: depthOf(all, unit.id), reasons });
    }
  }
  return pending.sort(
    (a, b) => b.depth - a.depth || a.unit.localeCompare(b.unit),
  );
}

/** Something a person has to decide or confirm, on their desk. */
export type DeskItem =
  | {
      kind: "escalation" | "request" | "note";
      message: Message;
      unitName: string;
    }
  | {
      kind: "confirm";
      assignment: Assignment;
      directive: Omit<Directive, "assignments">;
      unitName: string;
    };

/**
 * What waits on `person`: messages that climbed to a unit they steer, and
 * translations of their directives they have to confirm. Oldest first.
 */
export async function decisionDesk(
  person: string,
  database: Database = defaultDb(),
): Promise<DeskItem[]> {
  const all = await listUnits(database);
  const name = (id: string) => all.find((u) => u.id === id)?.name ?? id;
  const messages = (await waitingOnPeople(database)).filter(
    (m) => personOf(all, m.toUnit) === person,
  );
  const proposed = await database
    .select()
    .from(directiveAssignments)
    .where(eq(directiveAssignments.state, "proposed"));
  const parents = proposed.length
    ? await database
        .select()
        .from(directives)
        .where(
          inArray(
            directives.id,
            proposed.map((a) => a.directiveId),
          ),
        )
    : [];
  const confirms: DeskItem[] = proposed.flatMap((assignment) => {
    const directive = parents.find((d) => d.id === assignment.directiveId);
    if (!directive || personOf(all, directive.fromUnit) !== person) return [];
    return [
      {
        kind: "confirm" as const,
        assignment,
        directive,
        unitName: name(assignment.unitId),
      },
    ];
  });
  return [
    ...messages.map((message) => ({
      kind: message.kind,
      message,
      unitName: name(message.fromUnit),
    })),
    ...confirms,
  ];
}
