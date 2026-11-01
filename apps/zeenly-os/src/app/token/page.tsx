import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { listTokens } from "@zeenly-os/core";

import { currentPerson } from "@/lib/person";

import { revokeTokenAction } from "./actions";
import { TokenForm } from "./token-form";

// Reads the database on every request; there is nothing to prerender.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Your tokens" };

/**
 * Tokens that act as you, for your own Claude Code and for sessions you run
 * elsewhere. A hosted server has no token file beside it, so this page is
 * how you get one.
 */
export default async function TokenPage() {
  const person = await currentPerson();
  if (!person) redirect("/setup");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? "http";
  const mcpUrl = `${proto}://${host}/api/mcp`;
  const mine = (await listTokens()).filter(
    (t) => t.actor.kind === "human" && t.actor.id === person.id && !t.revokedAt,
  );
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 space-y-8 px-4 py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Your tokens</h1>
        <p className="mt-2 text-muted">
          A token acts as <span className="font-mono">{person.id}</span> in the
          tree: everything a person may do. Give one to your own Claude Code, or
          to a session that works for you somewhere else. Revoke it here when
          that machine is gone.
        </p>
      </header>
      <TokenForm mcpUrl={mcpUrl} />
      <section>
        <h2 className="text-sm font-medium tracking-wide text-subtle">
          Live tokens
        </h2>
        {mine.length ? (
          <ul className="mt-2 divide-y divide-line rounded-xl border border-line bg-surface text-sm">
            {mine.map((t) => (
              <li
                key={t.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
              >
                <span>
                  <span className="font-medium">{t.label ?? "(no label)"}</span>
                  <span className="ml-2 text-muted">
                    since {t.createdAt.toISOString().slice(0, 10)}
                    {t.expiresAt
                      ? `, until ${t.expiresAt.toISOString().slice(0, 10)}`
                      : ""}
                  </span>
                </span>
                <form action={revokeTokenAction}>
                  <input type="hidden" name="id" value={t.id} />
                  <button
                    type="submit"
                    className="text-negative hover:underline"
                  >
                    Revoke
                  </button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted">None yet.</p>
        )}
      </section>
    </main>
  );
}
