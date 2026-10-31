/**
 * The function tree's agent interface: an MCP server (streamable HTTP,
 * stateless, JSON replies) served at /api/mcp. Units' agents and people's
 * own tools read and write the tree only through these; the pages a person
 * uses call the same core functions. Who is calling comes from the token the
 * app resolved, passed in as `actor`; a tool's `unit` or `from` says which
 * unit the call is about, and core refuses what the actor may not do.
 */

import { z } from "zod";

import { db as defaultDb, type Database } from "../db";
import type { Actor } from "./actors";
import { pendingUnits, treeOverview, unitView } from "./agenda";
import {
  grantCapability,
  listCapabilities,
  revokeCapability,
} from "./capabilities";
import {
  closeDirective,
  directiveChain,
  getDirective,
  issueDirective,
  translateDirective,
} from "./directives";
import { getUnitDoc, listUnitDocs, saveUnitDoc } from "./docs";
import { Forbidden, TreeError } from "./errors";
import { listEvents } from "./events";
import {
  inbox,
  passOnEscalation,
  resolveMessage,
  sendMessage,
} from "./messages";
import { listReports, submitReport } from "./reports";
import { addTask, claimTask, listTasks, updateTask } from "./tasks";
import { createUnit, deleteUnit, updateUnit } from "./units";

/** How a unit's agent works, sent to every client on connect. */
export const UNIT_PROTOCOL = `You are the agent of one unit in a function tree: a standing role with a charter (what it owns), a person who steers it, and a mode (steer or autopilot). Your token names your unit; you act as it and nothing else.

Start with unit_get on your unit. Read its charter, handbook (how your role works, what went wrong before) and guidelines (what your person decided when they overruled you; follow them before deciding anything they cover). unit_get's pending says why you were woken.

Then, within your charter:
- Translate each new directive (directive_translate) into your own goal for it, with how you'll know you've done your part, or say it isn't yours (relevant: false, with why). Add the tasks it takes (task_add, linked to the directive). A translation that came back with a note was corrected by your person: translate again and fix the tasks to match.
- Pass a directive on to your children (directive_issue with parentId) when parts of it are theirs.
- Answer every message waiting on you (message_resolve). A request from a peer you may decline, with why. An escalation from below you settle if it falls within your charter and is reversible (your decision stands for your person), else message_pass_on with your note.
- Can't settle something (it reaches past your charter, your person must decide, or it's irreversible): message_send kind escalation, saying what you need decided, the options and what you'd pick. It climbs to the first person who can decide. Need a peer to act: kind request.
- Work your tasks (task_claim, then task_update as they move). What you make outside the tree (code, a PR, a document) you link on the task.
- Report (report_submit) when pending says so: fixed fields, short. Carry bad news up whole; good news in a line. Once your children have reported, every sentence cites their report ids; never claim what no report says.
- Steered unit: do reversible things first and report them; wait for your person on irreversible ones (money, customers, anything published, deleting data).
- When your work changes what your handbook should say, save it (doc_save). Your charter and guidelines are your person's to write.
- Answers to what you sent show in unit_get's answers until your next report; reporting clears them.

When nothing in pending is left, stop.`;

type Ctx = { database: Database; now: Date; actor: Actor };

type Tool = {
  name: string;
  description: string;
  input: z.ZodObject;
  run: (args: never, ctx: Ctx) => Promise<unknown>;
};

const unit = z.string().describe("The unit's id");
const line = z.union([
  z.string(),
  z.object({
    text: z.string(),
    cites: z
      .array(z.number().int())
      .optional()
      .describe("Report ids from below this unit"),
  }),
]);

function tool<S extends z.ZodObject>(
  name: string,
  description: string,
  input: S,
  run: (args: z.infer<S>, ctx: Ctx) => Promise<unknown>,
): Tool {
  return { name, description, input, run: run as Tool["run"] };
}

/** A unit's agent reads only its own unit; people and the system read any. */
function readable(actor: Actor, id: string): void {
  if (actor.kind === "unit" && actor.id !== id) {
    throw new Forbidden(
      `unit:${actor.id} reads its own unit; ${id} shows it only what unit_get's view includes`,
    );
  }
}

export const TREE_TOOLS: Tool[] = [
  tool(
    "unit_pending",
    "Units whose agents have something to do now, deepest first, with what. Empty: nothing to do.",
    z.object({}),
    (_, { database, now }) => pendingUnits({ now }, database),
  ),
  tool(
    "unit_tree",
    "The whole tree: each unit's id, parent, mode, person, rolled-up status, latest headline and counts.",
    z.object({}),
    async (_, { database }) =>
      (await treeOverview(database)).map((n) => ({
        id: n.unit.id,
        parentId: n.unit.parentId,
        name: n.unit.name,
        summary: n.unit.summary,
        mode: n.unit.mode,
        person: n.person,
        status: n.status,
        headline: n.latest?.headline.text ?? null,
        openTasks: n.openTasks,
        inbox: n.inbox,
      })),
  ),
  tool(
    "unit_get",
    "Everything a unit's agent works from: its charter and documents, its view of the tree, its directives, tasks, inbox, answers to what it sent, its children's latest reports (to cite), and why it was woken.",
    z.object({ unit }),
    ({ unit }, { database, actor }) => {
      readable(actor, unit);
      return unitView(unit, database);
    },
  ),
  tool(
    "unit_create",
    "A person adds a unit under one they steer, or a new root. The charter becomes its first document.",
    z.object({
      id: z.string().describe("A slug: lower-case letters, digits, dashes"),
      parentId: z.string().nullable().optional(),
      name: z.string(),
      summary: z.string().describe("One line: what it's for"),
      charter: z
        .string()
        .optional()
        .describe("Markdown: what it owns and doesn't"),
      mode: z.enum(["steer", "autopilot"]).optional(),
    }),
    (args, { database, now, actor }) =>
      createUnit(args, actor, { now }, database),
  ),
  tool(
    "unit_update",
    "The unit's person changes its name, summary, mode, parent or place among its siblings.",
    z.object({
      unit,
      name: z.string().optional(),
      summary: z.string().optional(),
      mode: z.enum(["steer", "autopilot"]).optional(),
      parentId: z.string().nullable().optional(),
      position: z
        .number()
        .int()
        .optional()
        .describe("Its place among its siblings, smallest first"),
    }),
    ({ unit, ...patch }, { database, now, actor }) =>
      updateUnit(unit, patch, actor, { now }, database),
  ),
  tool(
    "unit_delete",
    "The unit's person removes it, if nothing hangs off it yet (no units below, no history).",
    z.object({ unit }),
    async ({ unit }, { database, now, actor }) => {
      await deleteUnit(unit, actor, { now }, database);
      return { deleted: unit };
    },
  ),
  tool(
    "unit_events",
    "A unit's activity, newest first: every change about it, who made it, and what it served.",
    z.object({
      unit,
      limit: z.number().int().min(1).max(200).optional(),
      before: z
        .number()
        .int()
        .optional()
        .describe("Page back from this event id"),
    }),
    ({ unit, limit, before }, { database, actor }) => {
      readable(actor, unit);
      return listEvents({ unit, limit, before }, database);
    },
  ),
  tool(
    "doc_list",
    "A unit's documents at their latest versions: charter, handbook, guidelines, and any of its own.",
    z.object({ unit }),
    ({ unit }, { database, actor }) => {
      readable(actor, unit);
      return listUnitDocs(unit, database);
    },
  ),
  tool(
    "doc_get",
    "One of a unit's documents: its body, version, author and reason; or an older version.",
    z.object({
      unit,
      name: z.string(),
      version: z.number().int().optional(),
    }),
    async (args, { database, actor }) => {
      readable(actor, args.unit);
      const found = await getUnitDoc(args, database);
      if (!found) throw new TreeError(`${args.unit} has no ${args.name}`);
      return found;
    },
  ),
  tool(
    "doc_save",
    "Saves a document's next version. baseVersion is the version you changed (0 for a new one); if someone saved since, read it again and redo your change. The charter and guidelines are the unit's person's to save.",
    z.object({
      unit,
      name: z
        .string()
        .describe(
          "handbook, or a slug of your own; charter and guidelines for its person",
        ),
      body: z.string().describe("The whole document, as Markdown"),
      baseVersion: z.number().int(),
      reason: z.string().describe("Why it changed, in a sentence"),
    }),
    (args, { database, now, actor }) =>
      saveUnitDoc(args, actor, { now }, database),
  ),
  tool(
    "directive_issue",
    "Sends a directive from a unit: to units below it, a directive they must answer; to others, a request they may decline. Pass parentId to pass on a directive you were sent.",
    z.object({
      from: unit,
      to: z.array(z.string()).min(1),
      title: z.string(),
      body: z.string().optional(),
      doneWhen: z.string().describe("How the issuer will tell it's met"),
      dueOn: z.string().optional().describe("YYYY-MM-DD"),
      parentId: z.number().int().optional(),
    }),
    (args, { database, now, actor }) =>
      issueDirective(args, actor, { now }, database),
  ),
  tool(
    "directive_translate",
    "A unit's goal for a directive it was sent, or relevant: false with the reason it isn't the unit's.",
    z.object({
      directive: z.number().int(),
      unit,
      translation: z.string().optional(),
      relevant: z.boolean().optional(),
      reason: z.string().optional(),
    }),
    (args, { database, now, actor }) =>
      translateDirective(args, actor, { now }, database),
  ),
  tool(
    "directive_get",
    "A directive: every unit's part and translation, the directives passed on from it, and reports on it.",
    z.object({ directive: z.number().int() }),
    async ({ directive }, { database }) => {
      const found = await getDirective(directive, database);
      if (!found) throw new TreeError(`No directive ${directive}`);
      return {
        ...found,
        passedOn: await directiveChain(directive, database),
        reports: await listReports({ directive }, database),
      };
    },
  ),
  tool(
    "directive_close",
    "The issuing unit ends its directive: done (met) or dropped, with how it ended.",
    z.object({
      directive: z.number().int(),
      unit,
      status: z.enum(["done", "dropped"]),
      outcome: z.string(),
    }),
    (args, { database, now, actor }) =>
      closeDirective(args, actor, { now }, database),
  ),
  tool(
    "task_list",
    "A unit's tasks, most urgent first; open and doing unless statuses. Without a unit, everyone's (people and the system).",
    z.object({
      unit: unit.optional(),
      statuses: z
        .array(z.enum(["open", "doing", "done", "dropped"]))
        .optional(),
    }),
    (args, { database, actor }) => {
      if (actor.kind === "unit") readable(actor, args.unit ?? "");
      return listTasks(args, database);
    },
  ),
  tool(
    "task_add",
    "Adds a task to a unit: enough detail that a fresh session can finish it. priority 0 (most urgent) to 3. A person's task is pinned: its agent leaves the priority alone.",
    z.object({
      unit,
      title: z.string(),
      detail: z.string().optional(),
      priority: z.number().int().optional(),
      directive: z
        .number()
        .int()
        .optional()
        .describe("The directive it serves"),
    }),
    (args, { database, now, actor }) => addTask(args, actor, { now }, database),
  ),
  tool(
    "task_claim",
    "Takes an open task of your unit to work on.",
    z.object({ task: z.number().int() }),
    (args, { database, now, actor }) =>
      claimTask(args, actor, { now }, database),
  ),
  tool(
    "task_update",
    "Changes a task: status, title, detail, priority, or the PR that does it.",
    z.object({
      task: z.number().int(),
      status: z.enum(["open", "doing", "done", "dropped"]).optional(),
      title: z.string().optional(),
      detail: z.string().optional(),
      priority: z.number().int().optional(),
      prUrl: z.string().optional(),
    }),
    (args, { database, now, actor }) =>
      updateTask(args, actor, { now }, database),
  ),
  tool(
    "message_send",
    "From a unit: request (to a peer, which may decline), note, or escalation (no `to`: it climbs to whoever can decide).",
    z.object({
      from: unit,
      kind: z.enum(["request", "escalation", "note"]),
      to: z.string().optional(),
      subject: z.string(),
      body: z
        .string()
        .optional()
        .describe(
          "For an escalation: what to decide, the options, what you'd pick",
        ),
      directive: z.number().int().optional(),
    }),
    (args, { database, now, actor }) =>
      sendMessage(args, actor, { now }, database),
  ),
  tool(
    "message_inbox",
    "What waits on a unit's agent.",
    z.object({ unit }),
    ({ unit }, { database, actor }) => {
      readable(actor, unit);
      return inbox(unit, { forPerson: false }, database);
    },
  ),
  tool(
    "message_resolve",
    "Settles a message waiting on you (decline: true refuses a request). What waits on a person, only that person settles; their decision on an escalation joins the sender's guidelines.",
    z.object({
      message: z.number().int(),
      resolution: z.string(),
      decline: z.boolean().optional(),
    }),
    (args, { database, now, actor }) =>
      resolveMessage(args, actor, { now }, database),
  ),
  tool(
    "message_pass_on",
    "The autopilot unit holding an escalation can't settle it: it moves one step up, with your note.",
    z.object({ message: z.number().int(), unit, note: z.string().optional() }),
    (args, { database, now, actor }) =>
      passOnEscalation(args, actor, { now }, database),
  ),
  tool(
    "report_submit",
    "A unit's report: status (ok, risk, stuck, idle), a headline, done, blocked, next, numbers. Once children have reported, every sentence cites their report ids.",
    z.object({
      unit,
      directive: z.number().int().optional(),
      status: z.enum(["ok", "risk", "stuck", "idle"]),
      headline: line,
      done: z.array(line).optional(),
      blocked: z.array(line).optional(),
      next: z.array(line).optional(),
      numbers: z
        .array(
          z.object({
            name: z.string(),
            value: z.number(),
            target: z.number().optional(),
          }),
        )
        .optional(),
    }),
    (args, { database, now, actor }) =>
      submitReport(args, actor, { now }, database),
  ),
  tool(
    "capability_list",
    "The tools a unit may use, with scope and approval level. The command running its agent connects only these.",
    z.object({ unit }),
    ({ unit }, { database, actor }) => {
      readable(actor, unit);
      return listCapabilities(unit, database);
    },
  ),
  tool(
    "capability_grant",
    "The person steering a unit's parent gives it a tool (a root's own person, for a root), within what the parent has. level: who approves its use, root, parent or self.",
    z.object({
      unit,
      tool: z
        .string()
        .describe("shell, files, github, web, or an MCP server's name"),
      scope: z
        .string()
        .optional()
        .describe("A repository, path or domain; empty is everything"),
      level: z.enum(["root", "parent", "self"]).optional(),
    }),
    (args, { database, now, actor }) =>
      grantCapability(args, actor, { now }, database),
  ),
  tool(
    "capability_revoke",
    "Takes a tool from a unit and from every unit below it that held it within that scope.",
    z.object({ unit, tool: z.string(), scope: z.string().optional() }),
    (args, { database, now, actor }) =>
      revokeCapability(args, actor, { now }, database),
  ),
];

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

type RpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

/**
 * Answers one JSON-RPC message for `actor`; null for a notification, which
 * gets no reply. Tool failures the caller can fix come back as tool errors
 * with the reason, so the agent can read it and try again.
 */
export async function handleMcp(
  message: unknown,
  {
    actor,
    database = defaultDb(),
    now = new Date(),
  }: { actor: Actor; database?: Database; now?: Date },
): Promise<Record<string, unknown> | null> {
  const req = (message ?? {}) as RpcRequest;
  if (req.id === undefined || req.id === null) return null;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
  const fail = (code: number, text: string) => ({
    jsonrpc: "2.0",
    id: req.id,
    error: { code, message: text },
  });

  switch (req.method) {
    case "initialize": {
      const asked = String(req.params?.protocolVersion ?? "");
      return reply({
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "zeenly-os", version: "0" },
        instructions: UNIT_PROTOCOL,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: TREE_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: jsonSchema(t.input),
        })),
      });
    case "tools/call": {
      const name = req.params?.name;
      const found = TREE_TOOLS.find((t) => t.name === name);
      if (!found) return fail(-32602, `No tool ${String(name)}`);
      const args = found.input.safeParse(req.params?.arguments ?? {});
      if (!args.success) {
        return reply(toolError(z.prettifyError(args.error)));
      }
      try {
        const result = await found.run(args.data as never, {
          database,
          now,
          actor,
        });
        return reply({
          content: [
            { type: "text", text: JSON.stringify(result ?? null, null, 1) },
          ],
        });
      } catch (err) {
        if (err instanceof TreeError) return reply(toolError(err.message));
        throw err;
      }
    }
    default:
      return fail(-32601, `No method ${String(req.method)}`);
  }
}

function toolError(text: string) {
  return { content: [{ type: "text", text }], isError: true };
}

function jsonSchema(schema: z.ZodObject): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...z.toJSONSchema(schema, { io: "input" }),
  };
  delete out.$schema;
  return out;
}
