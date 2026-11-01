import { redirect } from "next/navigation";

import {
  databaseInfo,
  decisionDesk,
  listUnits,
  type TreeNode,
  treeOverview,
} from "@zeenly-os/core";

import { currentPerson } from "@/lib/person";

// Reads the database on every request; there is nothing to prerender.
export const dynamic = "force-dynamic";

/**
 * The company as it stands. Until the pages for the desk, the tree and each
 * role arrive, this is the one page: who waits on you, each role's colour,
 * and how to run the roles.
 */
export default async function HomePage() {
  const person = await currentPerson();
  if (!person) redirect("/setup");
  const [nodes, desk, all] = await Promise.all([
    treeOverview(),
    decisionDesk(person.id),
    listUnits(),
  ]);
  const roots = all.filter((u) => !u.parentId);
  const schedulerOn = process.env.ZEENLY_OS_SCHEDULER !== "off";
  const database = databaseInfo();
  const tone: Record<string, string> = {
    ok: "text-positive",
    risk: "text-warning",
    stuck: "text-negative",
    idle: "text-subtle",
  };
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 space-y-10 px-4 py-10">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">
          {roots.length === 1 ? roots[0].name : "Your companies"}
        </h1>
        <p className="mt-1 text-sm text-muted">
          You steer {roots.length === 1 ? "it" : "them"} as{" "}
          <span className="font-mono">{person.id}</span>.
          {desk.length
            ? ` ${desk.length} thing${desk.length === 1 ? "" : "s"} wait on you.`
            : " Nothing waits on you."}
        </p>
      </header>

      {roots.map((root) => (
        <section key={root.id}>
          <h2 className="text-sm font-medium tracking-wide text-subtle">
            {roots.length === 1 ? "Roles" : `${root.name}: roles`}
          </h2>
          <ul className="mt-2 divide-y divide-line rounded-xl border border-line bg-surface">
            {nodesUnder(nodes, root.id).map((n) => (
              <li
                key={n.unit.id}
                className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3"
                style={{ paddingLeft: `${1 + n.depth}rem` }}
              >
                <span>
                  <span className="font-medium">{n.unit.name}</span>
                  <span className="ml-2 text-sm text-muted">
                    {n.unit.summary}
                  </span>
                </span>
                <span className="flex items-center gap-3 text-sm">
                  <span className="text-subtle">{n.unit.mode}</span>
                  <span className={n.status ? tone[n.status] : "text-subtle"}>
                    {n.status ?? "no report yet"}
                  </span>
                  {n.openTasks > 0 && (
                    <span className="text-subtle">{n.openTasks} tasks</span>
                  )}
                  {n.inbox > 0 && (
                    <span className="text-subtle">{n.inbox} in inbox</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <section className="rounded-xl border border-line bg-surface-2 px-4 py-4 text-sm">
        <h2 className="font-medium">Run the roles</h2>
        <p className="mt-1 text-muted">
          With Claude Code installed and signed in on this machine:
        </p>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-background px-3 py-2 font-mono text-xs">
          zeenly-os run
        </pre>
        <p className="mt-2 text-muted">
          Your own Claude Code can work the tree as you with a token from{" "}
          <a href="/token" className="underline">
            /token
          </a>
          .
        </p>
        <p className="mt-2 text-muted">
          {schedulerOn
            ? "The scheduler in this server does that on its own every few minutes; the command runs a pass now."
            : "The scheduler is off on this server (ZEENLY_OS_SCHEDULER=off): roles run when you run that command on a machine with Claude Code, or when you work as them from your own Claude."}{" "}
          Each role that has something to do gets its own session, with a token
          that acts only as that role and the tools you granted it. Data:{" "}
          {database.kind === "embedded"
            ? "embedded database at"
            : "Postgres at"}{" "}
          <span className="font-mono">{database.where}</span>.
        </p>
      </section>
    </main>
  );
}

/** A root's subtree, in tree order: the root itself and everything under it. */
function nodesUnder(nodes: TreeNode[], rootId: string): TreeNode[] {
  const start = nodes.findIndex((n) => n.unit.id === rootId);
  if (start < 0) return [];
  const out = [nodes[start]];
  for (let i = start + 1; i < nodes.length && nodes[i].depth > 0; i++) {
    out.push(nodes[i]);
  }
  return out;
}
