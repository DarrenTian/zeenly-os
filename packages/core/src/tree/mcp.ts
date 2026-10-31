/**
 * The function tree's agent interface: an MCP server (streamable HTTP,
 * stateless, JSON replies) served at /api/mcp. Units' agents and any
 * session read and write the tree only through these tools; the pages a
 * person uses call the same core functions.
 */

import { z } from "zod";

import { db as defaultDb, type Database } from "../db";
import { pendingUnits, treeOverview, unitView } from "./agenda";
import { getUnitDoc, saveUnitDoc } from "./docs";
import {
  closeDirective,
  directiveChain,
  getDirective,
  issueDirective,
  translateDirective,
} from "./directives";
import {
  inbox,
  passOnEscalation,
  resolveMessage,
  sendMessage,
} from "./messages";
import { listReports, submitReport } from "./reports";
import { addTask, claimTask, listTasks, updateTask } from "./tasks";
import { createUnit, deleteUnit, TreeError, updateUnit } from "./units";

/** How a unit's agent works, sent to every client on connect. */
export const UNIT_PROTOCOL = `You act for units of a function tree: standing roles, each with a charter, a person who steers it, and a mode.

Run: call unit_pending; for each unit it lists (deepest first), call unit_get and act as that unit, within its charter, then go on to the next. Then call unit_pending again: what you did may have woken other units (a request, an escalation, a report). Repeat until it's empty, at most 12 units in all. Nothing pending: stop.

As a unit:
- Translate each new directive (directive_translate) into your own goal for it, in your charter's terms, with how you'll know you've done your part; or say it isn't yours (relevant: false, with why). Then add the tasks it takes (task_add, linked to the directive). A translation of a root's directive by one of its own children waits for the root's person to confirm (needsConfirm, state proposed); add its tasks anyway, and if it's sent back (state new, with a note) the note is your person's correction: translate again and fix the tasks to match.
- Pass a directive on to your children (directive_issue with parentId) when parts of it are theirs.
- Answer every message waiting on you (message_resolve). A request from a peer you may decline, with why. An escalation from below: settle it if it falls within your charter and is reversible (your decision stands for your person), else message_pass_on with your note.
- Can't settle something (it reaches past your charter, or your steered person must decide, or it's irreversible): message_send kind escalation, saying what you need decided, the options and what you'd pick. It goes up to the first person who can decide.
- Need a peer to act: message_send kind request.
- Report (report_submit) when unit_pending says so: fixed fields, short. Carry bad news up whole; good news in a line. A unit whose children have reported cites, in every sentence, the report ids from below it rests on; never claim what no report says.
- Steered unit: do reversible things first and report them; wait for your person on irreversible ones (money, customers, anything published, deleting data).
- Code, documents and PRs: add a task with enough detail for any session to finish it; don't do it yourself in this run.
- Answers to what you sent show in unit_get's answers until your next report; reporting clears them.
- Your documents (unit_get's docs) are your memory: handbook is how your role does its work, including what went wrong before; guidelines are what your person decided when they overruled you, one line each, and you follow them. Read them with doc_get before deciding anything they might cover; when your work changes what one should say, save it with doc_save. Your charter (what you own) is your person's to change, not yours.
- Pass your session's name where a tool asks for it: "by", or "source" on task_add.`;

type Ctx = { database: Database; now: Date };

type Tool = {
  name: string;
  description: string;
  input: z.ZodObject;
  run: (args: never, ctx: Ctx) => Promise<unknown>;
};

const by = z.string().min(1).describe("Your session's name or link");
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
    "Everything a unit's agent works from: its charter, its view of the tree, its directives, tasks, inbox, answers to what it sent, and its children's latest reports (to cite).",
    z.object({ unit }),
    ({ unit }, { database }) => unitView(unit, database),
  ),
  tool(
    "unit_create",
    "Adds a unit under a parent (or a new root).",
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
    (args, { database }) => createUnit(args, database),
  ),
  tool(
    "unit_update",
    "Changes a unit's name, summary, charter, parent or place among its siblings.",
    z.object({
      unit,
      name: z.string().optional(),
      summary: z.string().optional(),
      charter: z.string().optional(),
      parentId: z.string().nullable().optional(),
      position: z
        .number()
        .int()
        .optional()
        .describe("Its place among its siblings, smallest first"),
    }),
    ({ unit, ...patch }, { database, now }) =>
      updateUnit(unit, patch, { now }, database),
  ),
  tool(
    "unit_delete",
    "Removes a unit nothing hangs off yet (no units below it, no history).",
    z.object({ unit }),
    async ({ unit }, { database }) => {
      await deleteUnit(unit, database);
      return { deleted: unit };
    },
  ),
  tool(
    "doc_get",
    "One of a unit's documents (unit_get lists them): its body, version, author and reason. handbook and guidelines carry meaning; a unit may keep others.",
    z.object({
      unit,
      name: z.string(),
      version: z.number().int().optional(),
    }),
    async (args, { database }) => {
      const found = await getUnitDoc(args, database);
      if (!found) throw new TreeError(`${args.unit} has no ${args.name}`);
      return found;
    },
  ),
  tool(
    "doc_save",
    "Saves a document's next version. baseVersion is the version you changed (0 for a new one); if someone saved since, read it again and redo your change.",
    z.object({
      unit,
      name: z.string().describe("handbook, guidelines, or a slug of your own"),
      body: z.string().describe("The whole document, as Markdown"),
      baseVersion: z.number().int(),
      reason: z.string().describe("Why it changed, in a sentence"),
      by,
    }),
    ({ by, ...args }, { database }) =>
      saveUnitDoc({ ...args, author: by }, database),
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
      by,
    }),
    (args, { database }) => issueDirective(args, database),
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
    (args, { database, now }) => translateDirective(args, { now }, database),
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
    (args, { database, now }) => closeDirective(args, { now }, database),
  ),
  tool(
    "task_list",
    "A unit's tasks (all units without one), most urgent first; open and doing unless statuses.",
    z.object({
      unit: unit.optional(),
      statuses: z
        .array(z.enum(["open", "doing", "done", "dropped"]))
        .optional(),
    }),
    (args, { database }) => listTasks(args, database),
  ),
  tool(
    "task_add",
    "Adds a task to a unit: enough detail that any session can finish it. priority 0 (most urgent) to 3.",
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
      source: by,
    }),
    (args, { database }) => addTask(args, database),
  ),
  tool(
    "task_claim",
    "A session takes an open task to work on.",
    z.object({ task: z.number().int(), by }),
    (args, { database, now }) => claimTask(args, { now }, database),
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
    (args, { database, now }) => updateTask(args, { now }, database),
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
      by,
    }),
    (args, { database }) => sendMessage(args, database),
  ),
  tool(
    "message_inbox",
    "What waits on a unit's agent.",
    z.object({ unit }),
    ({ unit }, { database }) => inbox(unit, { forPerson: false }, database),
  ),
  tool(
    "message_resolve",
    "The unit a message waits on answers it (decline: true refuses a request). Messages waiting on a person are theirs to settle.",
    z.object({
      message: z.number().int(),
      unit,
      resolution: z.string(),
      decline: z.boolean().optional(),
      by,
    }),
    (args, { database, now }) => resolveMessage(args, { now }, database),
  ),
  tool(
    "message_pass_on",
    "The autopilot unit holding an escalation can't settle it: it moves one step up, with your note.",
    z.object({ message: z.number().int(), unit, note: z.string().optional() }),
    (args, { database }) => passOnEscalation(args, database),
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
      by,
    }),
    (args, { database, now }) => submitReport(args, { now }, database),
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
 * Answers one JSON-RPC message; null for a notification, which gets no
 * reply. Tool failures the caller can fix come back as tool errors with the
 * reason, so the agent can read it and try again.
 */
export async function handleMcp(
  message: unknown,
  {
    database = defaultDb(),
    now = new Date(),
  }: { database?: Database; now?: Date } = {},
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
        const result = await found.run(args.data as never, { database, now });
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
