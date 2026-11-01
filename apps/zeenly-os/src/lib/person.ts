import { type Actor, listUnits, personOf } from "@zeenly-os/core";

import { requireSignIn } from "./auth";

/**
 * Who the pages act as. This install belongs to one person: the one who
 * steers its first root. Until a company exists there is nobody, and the
 * pages send you to set one up.
 */
export async function currentPerson(): Promise<Actor | null> {
  await requireSignIn();
  const all = await listUnits();
  const root = all.find((u) => !u.parentId);
  const id = root ? personOf(all, root.id) : null;
  return id ? { kind: "human", id } : null;
}
