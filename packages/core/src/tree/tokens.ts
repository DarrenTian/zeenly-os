/**
 * Bearer tokens, each acting as one actor. The command that runs a unit's
 * agent mints a short-lived token for that unit and hands it to the session,
 * so the session can act as nothing else; a person mints a long-lived one for
 * tools of their own. Only hashes are stored: a token is shown once.
 */

import { createHash, randomBytes } from "node:crypto";

import { desc, eq } from "drizzle-orm";

import { db as defaultDb, type Database } from "../db";
import { tokens } from "../db/schema";
import type { Actor } from "./actors";
import { Forbidden, TreeError } from "./errors";
import { write } from "./events";

export type IssuedToken = {
  id: string;
  /** The secret, shown this once. */
  token: string;
  actor: Actor;
  label: string;
  expiresAt: Date | null;
};

export type TokenInfo = Omit<IssuedToken, "token"> & {
  createdAt: Date;
  revokedAt: Date | null;
};

const PREFIX = "zos_";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A person or the scheduler mints a token; a unit's agent can't. */
export async function issueToken(
  input: { actor: Actor; label?: string; ttlMs?: number | null },
  by: Actor,
  { now = new Date() }: { now?: Date } = {},
  database: Database = defaultDb(),
): Promise<IssuedToken> {
  if (by.kind === "unit") {
    throw new Forbidden("A unit's agent doesn't mint tokens");
  }
  if (input.actor.kind === "system") {
    throw new TreeError("The system acts without a token");
  }
  if (!input.actor.id.trim()) throw new TreeError("Name the actor");
  const token = PREFIX + randomBytes(24).toString("hex");
  const expiresAt =
    input.ttlMs == null ? null : new Date(now.getTime() + input.ttlMs);
  const row = await write(
    database,
    by,
    async (tx) => {
      const [r] = await tx
        .insert(tokens)
        .values({
          hash: digest(token),
          actorKind: input.actor.kind,
          actorId: input.actor.id,
          label: input.label?.trim() ?? "",
          expiresAt,
          createdAt: now,
        })
        .returning();
      return r;
    },
    (r) => ({
      what: "token.issued",
      on: { kind: "token", id: r.id },
      unit: input.actor.kind === "unit" ? input.actor.id : null,
      after: { id: r.id, actor: input.actor, label: r.label, expiresAt },
    }),
    now,
  );
  return { id: row.id, token, actor: input.actor, label: row.label, expiresAt };
}

/** The actor a token acts as; null for an unknown, expired or revoked one. */
export async function resolveToken(
  token: string,
  { now = new Date() }: { now?: Date } = {},
  database: Database = defaultDb(),
): Promise<Actor | null> {
  if (!token.startsWith(PREFIX)) return null;
  const [row] = await database
    .select()
    .from(tokens)
    .where(eq(tokens.hash, digest(token)));
  if (!row || row.revokedAt || (row.expiresAt && row.expiresAt <= now)) {
    return null;
  }
  return { kind: row.actorKind, id: row.actorId };
}

export async function revokeToken(
  id: string,
  by: Actor,
  { now = new Date() }: { now?: Date } = {},
  database: Database = defaultDb(),
): Promise<void> {
  if (by.kind === "unit") {
    throw new Forbidden("A unit's agent doesn't revoke tokens");
  }
  if (!UUID.test(id)) throw new TreeError(`No token ${id}`);
  const [row] = await database.select().from(tokens).where(eq(tokens.id, id));
  if (!row) throw new TreeError(`No token ${id}`);
  if (row.revokedAt) return;
  await write(
    database,
    by,
    async (tx) => {
      await tx.update(tokens).set({ revokedAt: now }).where(eq(tokens.id, id));
      return { id };
    },
    () => ({
      what: "token.revoked",
      on: { kind: "token", id },
      unit: row.actorKind === "unit" ? row.actorId : null,
    }),
    now,
  );
}

/** Every token, newest first, without its secret. */
export async function listTokens(
  database: Database = defaultDb(),
): Promise<TokenInfo[]> {
  const rows = await database
    .select()
    .from(tokens)
    .orderBy(desc(tokens.createdAt));
  return rows.map((r) => ({
    id: r.id,
    actor: { kind: r.actorKind, id: r.actorId },
    label: r.label,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
    revokedAt: r.revokedAt,
  }));
}
