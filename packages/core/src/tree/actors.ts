/**
 * Who acts on the tree. A unit's agent acts as that unit and nothing else; a
 * person acts as any unit they steer, and does what only people do (confirm
 * a translation, decide an escalation, change a charter or guidelines); the
 * system (the scheduler, later the evolution engine) informs and proposes.
 * Which one a call comes from is settled by its token, never by a parameter.
 */

import { Forbidden } from "./errors";

export type ActorKind = "unit" | "human" | "system";

export type Actor = { kind: ActorKind; id: string };

/** The actor that wakes units and runs their sessions. */
export const SCHEDULER: Actor = { kind: "system", id: "scheduler" };

/** "human:founder", "unit:growth": how an actor is written into a row. */
export function actorLabel(actor: Actor): string {
  return `${actor.kind}:${actor.id}`;
}

export function parseActor(label: string): Actor | null {
  const at = label.indexOf(":");
  if (at < 1) return null;
  const kind = label.slice(0, at);
  const id = label.slice(at + 1);
  if (!id || (kind !== "unit" && kind !== "human" && kind !== "system")) {
    return null;
  }
  return { kind, id };
}

/** The person's id, or Forbidden when the actor isn't a person. */
export function requireHuman(actor: Actor, doing: string): string {
  if (actor.kind !== "human") {
    throw new Forbidden(
      `Only a person ${doing}; ${actorLabel(actor)} isn't one`,
    );
  }
  return actor.id;
}
