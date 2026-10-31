import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// `pnpm db:generate` turns changes here into a migration under drizzle/.

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const unitModeEnum = pgEnum("unit_mode", ["steer", "autopilot"]);

/**
 * A standing role: a node of the tree. No fixed root or first layer: a tree
 * starts as one unit, grows children, and gains a parent when its person's
 * superior starts using it too.
 */
export const units = pgTable("units", {
  /** A slug ("engineering"), so agents can name it. */
  id: text("id").primaryKey(),
  /** Null for a root; there can be several. */
  parentId: text("parent_id").references((): AnyPgColumn => units.id),
  name: text("name").notNull(),
  /** One line: what it's for. Others see this much of it. */
  summary: text("summary").notNull(),
  /** What it does and doesn't own, as Markdown; its agent reads it first. */
  charter: text("charter").notNull().default(""),
  /**
   * Who steers it ("founder"), as an id so several people can each own a
   * subtree later. Null inherits the nearest ancestor's.
   */
  owner: text("owner"),
  mode: unitModeEnum("mode").notNull().default("steer"),
  /** Its order among its siblings, smallest first. */
  position: integer("position").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const directiveStatusEnum = pgEnum("directive_status", [
  "open",
  "done",
  "dropped",
]);

/**
 * A goal or project, raised by one unit and sent to others for a while.
 * Only its issuer judges whether it's met and closes it.
 */
export const directives = pgTable("directives", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  fromUnit: text("from_unit")
    .notNull()
    .references(() => units.id),
  /** The directive a unit passed this on from; null for an original. */
  parentId: integer("parent_id").references((): AnyPgColumn => directives.id),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  /** How the issuer will tell it's met. */
  doneWhen: text("done_when").notNull(),
  /** YYYY-MM-DD, or null without a deadline. */
  dueOn: text("due_on"),
  status: directiveStatusEnum("status").notNull().default("open"),
  /** Why it closed, from the issuer. */
  outcome: text("outcome"),
  /** "founder", or the session that issued it. */
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

/** Down the tree a directive must be answered; sideways, a peer may decline. */
export const assignmentKindEnum = pgEnum("assignment_kind", [
  "directive",
  "request",
]);

/**
 * new: waits for its unit to translate it. proposed: translated, waiting on
 * the issuer's person to confirm (a root's directives, guardrail ④). active:
 * the unit works to its translation. declined: not this unit's (with why).
 * closed: the directive ended.
 */
export const assignmentStateEnum = pgEnum("assignment_state", [
  "new",
  "proposed",
  "active",
  "declined",
  "closed",
]);

/** One unit's part in a directive: what it took the directive to mean. */
export const directiveAssignments = pgTable(
  "directive_assignments",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    directiveId: integer("directive_id")
      .notNull()
      .references(() => directives.id),
    unitId: text("unit_id")
      .notNull()
      .references(() => units.id),
    kind: assignmentKindEnum("kind").notNull(),
    state: assignmentStateEnum("state").notNull().default("new"),
    /** The unit's goal for the directive, in its own terms. */
    translation: text("translation"),
    /**
     * Why it declined, or the person's note when they sent the translation
     * back.
     */
    note: text("note"),
    /** Its person has to confirm the translation before it's active. */
    needsConfirm: boolean("needs_confirm").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("directive_assignments_unit_idx").on(t.directiveId, t.unitId),
  ],
);

export const taskStatusEnum = pgEnum("task_status", [
  "open",
  "doing",
  "done",
  "dropped",
]);

/** A unit's to-do: what any session could pick up and finish. */
export const unitTasks = pgTable(
  "unit_tasks",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    unitId: text("unit_id")
      .notNull()
      .references(() => units.id),
    title: text("title").notNull(),
    /** Enough that a new session can start without asking. */
    detail: text("detail").notNull().default(""),
    /** 0 is most urgent, 3 the least. */
    priority: integer("priority").notNull().default(2),
    status: taskStatusEnum("status").notNull().default("open"),
    /** The directive it serves; null for the unit's standing work. */
    directiveId: integer("directive_id").references(() => directives.id),
    /** Where it came from: a session link, "founder". */
    source: text("source").notNull(),
    /** The session working on it. */
    claimedBy: text("claimed_by"),
    prUrl: text("pr_url"),
    /** Its person placed it; re-ranks leave it where it is. */
    pinned: boolean("pinned").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("unit_tasks_unit_idx").on(t.unitId, t.status)],
);

/**
 * request: sideways, to a peer. escalation: up, something the sender
 * can't settle. note: anything else a unit should read.
 */
export const messageKindEnum = pgEnum("message_kind", [
  "request",
  "escalation",
  "note",
]);

export const messageStatusEnum = pgEnum("message_status", [
  "open",
  "resolved",
  "declined",
]);

/** Between units: the inbox of whoever it's addressed to now. */
export const unitMessages = pgTable(
  "unit_messages",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    kind: messageKindEnum("kind").notNull(),
    fromUnit: text("from_unit")
      .notNull()
      .references(() => units.id),
    /** Where it waits now; an escalation moves up as it's passed on. */
    toUnit: text("to_unit")
      .notNull()
      .references(() => units.id),
    /** Every unit an escalation passed through, the sender first. */
    path: jsonb("path").$type<string[]>().notNull(),
    /** It waits on `toUnit`'s person, not its agent. */
    forPerson: boolean("for_person").notNull().default(false),
    subject: text("subject").notNull(),
    body: text("body").notNull().default(""),
    directiveId: integer("directive_id").references(() => directives.id),
    status: messageStatusEnum("status").notNull().default("open"),
    /** The answer or decision, for the sender to read. */
    resolution: text("resolution"),
    resolvedBy: text("resolved_by"),
    /** "founder", or the session that sent it. */
    sentBy: text("sent_by").notNull(),
    createdAt: createdAt(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [index("unit_messages_inbox_idx").on(t.toUnit, t.status)],
);

/** How a report says the unit is doing: ok, at risk, stuck or idle. */
export const reportStatusEnum = pgEnum("report_status", [
  "ok",
  "risk",
  "stuck",
  "idle",
]);

/**
 * One sentence of a report. A unit with children cites, for every sentence,
 * the reports of theirs it rests on (guardrail ①).
 */
export type ReportLine = { text: string; cites: number[] };

/** One number a report gives. */
export type ReportNumber = { name: string; value: number; target?: number };

/**
 * A unit's report, in fixed fields. The latest one is its state; its
 * parent's reports compress it, carrying bad news up and good news in a
 * line.
 */
export const unitReports = pgTable(
  "unit_reports",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    unitId: text("unit_id")
      .notNull()
      .references(() => units.id),
    /** The directive it reports on; null for the unit's standing work. */
    directiveId: integer("directive_id").references(() => directives.id),
    status: reportStatusEnum("status").notNull(),
    headline: jsonb("headline").$type<ReportLine>().notNull(),
    done: jsonb("done").$type<ReportLine[]>().notNull(),
    blocked: jsonb("blocked").$type<ReportLine[]>().notNull(),
    next: jsonb("next").$type<ReportLine[]>().notNull(),
    numbers: jsonb("numbers").$type<ReportNumber[]>().notNull(),
    /** The session that wrote it. */
    author: text("author").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("unit_reports_unit_idx").on(t.unitId, t.createdAt)],
);

/**
 * A unit's documents: handbook, guidelines, or any slug of its own. Each
 * save adds a version, and saving over a version someone replaced fails.
 */
export const unitDocs = pgTable(
  "unit_docs",
  {
    id: id(),
    unitId: text("unit_id")
      .notNull()
      .references(() => units.id),
    /** A slug: "handbook", "x-style". */
    name: text("name").notNull(),
    version: integer("version").notNull(),
    body: text("body").notNull(),
    /** "founder", or the session that saved it. */
    author: text("author").notNull(),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("unit_docs_unit_name_version_idx").on(
      t.unitId,
      t.name,
      t.version,
    ),
  ],
);
