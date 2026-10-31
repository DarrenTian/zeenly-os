/**
 * Reports: how a unit is doing, in fixed fields. Status colours roll up
 * mechanically (a unit shows the worst in its subtree); the words are
 * written by each unit's agent. A unit whose children report may only say
 * what their reports say: every sentence cites at least one report from below
 * (guardrail ①), so a summary can't inflate or invent progress.
 */

import { and, desc, eq, inArray } from "drizzle-orm";

import { db as defaultDb, type Database } from "../db";
import { type ReportLine, type ReportNumber, unitReports } from "../db/schema";
import {
  descendants,
  findUnit,
  listUnits,
  TreeError,
  type Unit,
} from "./units";

export type ReportStatus = "ok" | "risk" | "stuck" | "idle";
export type Report = typeof unitReports.$inferSelect;
export type { ReportLine, ReportNumber };

/** A sentence as an agent may give it: bare text, or text with citations. */
export type LineInput = string | { text: string; cites?: number[] };

const SEVERITY: Record<ReportStatus, number> = {
  idle: 0,
  ok: 1,
  risk: 2,
  stuck: 3,
};

export async function submitReport(
  input: {
    unit: string;
    directive?: number | null;
    status: ReportStatus;
    headline: LineInput;
    done?: LineInput[];
    blocked?: LineInput[];
    next?: LineInput[];
    numbers?: ReportNumber[];
    by: string;
  },
  { now = new Date() }: { now?: Date } = {},
  database: Database = defaultDb(),
): Promise<Report> {
  const all = await listUnits(database);
  const unit = findUnit(all, input.unit);
  const headline = line(input.headline);
  if (!headline.text)
    throw new TreeError("Give the report a one-line headline");
  const sections = {
    done: (input.done ?? []).map(line).filter((l) => l.text),
    blocked: (input.blocked ?? []).map(line).filter((l) => l.text),
    next: (input.next ?? []).map(line).filter((l) => l.text),
  };
  if (input.status === "stuck" && !sections.blocked.length) {
    throw new TreeError("A stuck report says what it's stuck on (blocked)");
  }
  await checkCitations(
    all,
    unit,
    [headline, ...Object.values(sections).flat()],
    database,
  );
  const [row] = await database
    .insert(unitReports)
    .values({
      unitId: unit.id,
      directiveId: input.directive ?? null,
      status: input.status,
      headline,
      ...sections,
      numbers: input.numbers ?? [],
      author: input.by,
      createdAt: now,
    })
    .returning();
  return row;
}

function line(input: LineInput): ReportLine {
  return typeof input === "string"
    ? { text: input.trim(), cites: [] }
    : { text: input.text.trim(), cites: [...new Set(input.cites ?? [])] };
}

/**
 * Leaves cite nothing (they report their own work). A unit whose children
 * have reported cites, in every sentence, reports written by units below it.
 */
async function checkCitations(
  all: Unit[],
  unit: Unit,
  lines: ReportLine[],
  database: Database,
): Promise<void> {
  const cited = [...new Set(lines.flatMap((l) => l.cites))];
  const below = descendants(all, unit.id).map((u) => u.id);
  // Until someone below has reported there's nothing to compress, and the
  // unit reports its own work like a leaf.
  const [reported] = below.length
    ? await database
        .select({ id: unitReports.id })
        .from(unitReports)
        .where(inArray(unitReports.unitId, below))
        .limit(1)
    : [];
  if (reported) {
    const bare = lines.filter((l) => !l.cites.length).map((l) => `“${l.text}”`);
    if (bare.length) {
      throw new TreeError(
        `Every sentence of ${unit.id}'s report cites a report from below it; these don't: ${bare.join(" ")}`,
      );
    }
  }
  if (!cited.length) return;
  const found = await database
    .select({ id: unitReports.id, unitId: unitReports.unitId })
    .from(unitReports)
    .where(inArray(unitReports.id, cited));
  const wrong = cited.filter(
    (id) => !found.some((r) => r.id === id && below.includes(r.unitId)),
  );
  if (wrong.length) {
    throw new TreeError(
      `Reports ${wrong.join(", ")} aren't from units below ${unit.id}; cite only theirs`,
    );
  }
}

/** Each unit's latest report. */
export async function latestReports(
  database: Database = defaultDb(),
): Promise<Map<string, Report>> {
  const rows = await database
    .selectDistinctOn([unitReports.unitId])
    .from(unitReports)
    .orderBy(
      unitReports.unitId,
      desc(unitReports.createdAt),
      desc(unitReports.id),
    );
  return new Map(rows.map((r) => [r.unitId, r]));
}

/** A unit's recent reports, newest first. */
export async function listReports(
  {
    unit,
    directive,
    limit = 20,
  }: { unit?: string; directive?: number; limit?: number },
  database: Database = defaultDb(),
): Promise<Report[]> {
  return database
    .select()
    .from(unitReports)
    .where(
      and(
        unit ? eq(unitReports.unitId, unit) : undefined,
        directive ? eq(unitReports.directiveId, directive) : undefined,
      ),
    )
    .orderBy(desc(unitReports.createdAt), desc(unitReports.id))
    .limit(limit);
}

/**
 * Each unit's colour: the worst latest status in its subtree, itself
 * included; null where nobody in it has reported.
 */
export function rollUp(
  all: Unit[],
  latest: Map<string, Report>,
): Map<string, ReportStatus | null> {
  const rolled = new Map<string, ReportStatus | null>();
  const visit = (unit: Unit): ReportStatus | null => {
    let worst: ReportStatus | null = latest.get(unit.id)?.status ?? null;
    for (const child of all.filter((u) => u.parentId === unit.id)) {
      const theirs = visit(child);
      if (theirs && (!worst || SEVERITY[theirs] > SEVERITY[worst]))
        worst = theirs;
    }
    rolled.set(unit.id, worst);
    return worst;
  };
  for (const root of all.filter(
    (u) => !u.parentId || !all.some((p) => p.id === u.parentId),
  )) {
    visit(root);
  }
  return rolled;
}
