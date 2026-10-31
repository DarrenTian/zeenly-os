import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  env,
  issueToken,
  listUnits,
  personOf,
  resolveToken,
  SCHEDULER,
} from "@zeenly-os/core";

/**
 * The server owns the database (the embedded one allows a single process),
 * so the command line reaches it over HTTP like any agent does. For that it
 * needs a token: the server mints one for the install's person and keeps it
 * in a file only this user can read, and the CLI sends it as a bearer token.
 */
export function localTokenPath(): string {
  return join(env().ZEENLY_OS_DATA, "token");
}

/** The token in the file, or null when there is none yet. */
export function readLocalToken(): string | null {
  try {
    return readFileSync(localTokenPath(), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Makes sure the file holds a live token for the person who steers the
 * first root; nothing to do before a company exists. Called on server start
 * and right after setup.
 */
export async function ensureLocalToken(): Promise<string | null> {
  const all = await listUnits();
  const root = all.find((u) => !u.parentId);
  const person = root ? personOf(all, root.id) : null;
  if (!person) return null;
  const current = readLocalToken();
  if (current) {
    const actor = await resolveToken(current);
    if (actor?.kind === "human" && actor.id === person) return current;
  }
  const issued = await issueToken(
    { actor: { kind: "human", id: person }, label: "local", ttlMs: null },
    SCHEDULER,
  );
  mkdirSync(env().ZEENLY_OS_DATA, { recursive: true });
  writeFileSync(localTokenPath(), `${issued.token}\n`, { mode: 0o600 });
  chmodSync(localTokenPath(), 0o600);
  return issued.token;
}
