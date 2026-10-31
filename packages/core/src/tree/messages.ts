/**
 * Messages between units. A request goes sideways to a peer, which answers
 * or declines it. An escalation is something a unit can't settle: it climbs
 * parent pointers to the first unit that's steered, or to a root, and waits
 * there on that unit's person. An autopilot unit it passes through gets the
 * first go: its agent settles it (deciding for the person) or passes it on.
 * Escalations move the moment they're raised or passed on (guardrail ②);
 * only the agents' reviews run on a schedule.
 */

import { and, asc, eq, gt, inArray } from "drizzle-orm";

import { db as defaultDb, type Database } from "../db";
import { unitMessages } from "../db/schema";
import { findUnit, listUnits, personOf, TreeError, type Unit } from "./units";

export type MessageKind = "request" | "escalation" | "note";
export type Message = typeof unitMessages.$inferSelect;

/**
 * Where an escalation at `unit` waits: on the unit's person when it's
 * steered or has nobody above it, else on its parent's agent first.
 */
function landing(
  all: Unit[],
  unit: Unit,
): { toUnit: string; forPerson: boolean } {
  if (unit.mode === "steer" || !unit.parentId) {
    return { toUnit: unit.id, forPerson: true };
  }
  const parent = findUnit(all, unit.parentId);
  return {
    toUnit: parent.id,
    forPerson: parent.mode === "steer" || !parent.parentId,
  };
}

export async function sendMessage(
  input: {
    from: string;
    kind: MessageKind;
    to?: string;
    subject: string;
    body?: string;
    directive?: number | null;
    by: string;
  },
  database: Database = defaultDb(),
): Promise<Message> {
  const all = await listUnits(database);
  const from = findUnit(all, input.from);
  const subject = input.subject.trim();
  if (!subject) throw new TreeError("Give the message a subject");
  let toUnit: string;
  let forPerson = false;
  if (input.kind === "escalation") {
    ({ toUnit, forPerson } = landing(all, from));
  } else {
    if (!input.to) throw new TreeError(`A ${input.kind} needs a unit to go to`);
    toUnit = findUnit(all, input.to).id;
    if (toUnit === from.id) throw new TreeError("A unit can't message itself");
  }
  const [row] = await database
    .insert(unitMessages)
    .values({
      kind: input.kind,
      fromUnit: from.id,
      toUnit,
      path: toUnit === from.id ? [from.id] : [from.id, toUnit],
      forPerson,
      subject,
      body: input.body?.trim() ?? "",
      directiveId: input.directive ?? null,
      sentBy: input.by,
    })
    .returning();
  return row;
}

/**
 * The autopilot unit holding an escalation can't settle it either: it goes
 * one step further up, with the unit's note added for whoever decides.
 */
export async function passOnEscalation(
  input: { message: number; unit: string; note?: string },
  database: Database = defaultDb(),
): Promise<Message> {
  const message = await requireOpen(input.message, database);
  if (message.kind !== "escalation") {
    throw new TreeError(
      "Only an escalation is passed up; answer or decline a request",
    );
  }
  if (message.toUnit !== input.unit) {
    throw new TreeError(
      `Message ${message.id} waits on ${message.toUnit}, not ${input.unit}`,
    );
  }
  if (message.forPerson) {
    throw new TreeError(
      `Message ${message.id} already waits on ${message.toUnit}'s person`,
    );
  }
  const all = await listUnits(database);
  const holder = findUnit(all, message.toUnit);
  // One step: the parent's agent gets its go too, unless it's steered.
  const parent = holder.parentId ? findUnit(all, holder.parentId) : null;
  const stop = parent
    ? {
        toUnit: parent.id,
        forPerson: parent.mode === "steer" || !parent.parentId,
      }
    : { toUnit: holder.id, forPerson: true };
  const note = input.note?.trim();
  const [row] = await database
    .update(unitMessages)
    .set({
      toUnit: stop.toUnit,
      forPerson: stop.forPerson,
      path:
        message.path.at(-1) === stop.toUnit
          ? message.path
          : [...message.path, stop.toUnit],
      body: note
        ? `${message.body}\n\n${holder.id}：${note}`.trim()
        : message.body,
    })
    .where(eq(unitMessages.id, message.id))
    .returning();
  return row;
}

/**
 * Settles a message: the answer or decision goes back to its sender. One
 * waiting on a person is settled only by that person (`person`); an agent
 * settles what waits on its unit (`unit`).
 */
export async function resolveMessage(
  input: {
    message: number;
    resolution: string;
    decline?: boolean;
    unit?: string;
    person?: string;
    by: string;
  },
  { now = new Date() }: { now?: Date } = {},
  database: Database = defaultDb(),
): Promise<Message> {
  const message = await requireOpen(input.message, database);
  const all = await listUnits(database);
  if (input.person) {
    if (personOf(all, message.toUnit) !== input.person) {
      throw new TreeError(
        `Message ${message.id} isn't waiting on ${input.person}`,
      );
    }
  } else {
    if (message.forPerson) {
      throw new TreeError(
        `Message ${message.id} waits on ${message.toUnit}'s person; only they settle it`,
      );
    }
    if (message.toUnit !== input.unit) {
      throw new TreeError(
        `Message ${message.id} waits on ${message.toUnit}, not ${input.unit ?? "nobody"}`,
      );
    }
  }
  if (input.decline && message.kind !== "request") {
    throw new TreeError("Only a request can be declined");
  }
  const resolution = input.resolution.trim();
  if (!resolution)
    throw new TreeError("Write the answer or decision (resolution)");
  const [row] = await database
    .update(unitMessages)
    .set({
      status: input.decline ? "declined" : "resolved",
      resolution,
      resolvedBy: input.by,
      resolvedAt: now,
    })
    .where(eq(unitMessages.id, message.id))
    .returning();
  return row;
}

/** What waits on the unit, oldest first; for its agent unless `forPerson`. */
export async function inbox(
  unit: string,
  { forPerson }: { forPerson?: boolean } = {},
  database: Database = defaultDb(),
): Promise<Message[]> {
  return database
    .select()
    .from(unitMessages)
    .where(
      and(
        eq(unitMessages.toUnit, unit),
        eq(unitMessages.status, "open"),
        forPerson === undefined
          ? undefined
          : eq(unitMessages.forPerson, forPerson),
      ),
    )
    .orderBy(asc(unitMessages.id));
}

/** Answers to what the unit sent, settled after `since` (all, without). */
export async function answers(
  unit: string,
  since: Date | null,
  database: Database = defaultDb(),
): Promise<Message[]> {
  return database
    .select()
    .from(unitMessages)
    .where(
      and(
        eq(unitMessages.fromUnit, unit),
        inArray(unitMessages.status, ["resolved", "declined"]),
        since ? gt(unitMessages.resolvedAt, since) : undefined,
      ),
    )
    .orderBy(asc(unitMessages.resolvedAt));
}

/** Every open message, oldest first. */
export async function openMessages(
  database: Database = defaultDb(),
): Promise<Message[]> {
  return database
    .select()
    .from(unitMessages)
    .where(eq(unitMessages.status, "open"))
    .orderBy(asc(unitMessages.id));
}

/** Every open message waiting on a person, oldest first. */
export async function waitingOnPeople(
  database: Database = defaultDb(),
): Promise<Message[]> {
  return database
    .select()
    .from(unitMessages)
    .where(
      and(eq(unitMessages.status, "open"), eq(unitMessages.forPerson, true)),
    )
    .orderBy(asc(unitMessages.id));
}

export async function getMessage(
  id: number,
  database: Database = defaultDb(),
): Promise<Message | null> {
  const [row] = await database
    .select()
    .from(unitMessages)
    .where(eq(unitMessages.id, id));
  return row ?? null;
}

async function requireOpen(id: number, database: Database): Promise<Message> {
  const message = await getMessage(id, database);
  if (!message) throw new TreeError(`No message ${id}`);
  if (message.status !== "open") {
    throw new TreeError(`Message ${id} is settled already`);
  }
  return message;
}
