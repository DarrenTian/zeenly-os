"use client";

import { useActionState } from "react";

import { mintTokenAction, type TokenState } from "./actions";

export function TokenForm({ mcpUrl }: { mcpUrl: string }) {
  const [state, action, pending] = useActionState<TokenState, FormData>(
    mintTokenAction,
    {},
  );
  if (state.token) {
    return (
      <div className="space-y-3 rounded-xl border border-line bg-surface-2 px-4 py-4 text-sm">
        <p>
          Your token <span className="font-medium">{state.label}</span>. Copy it
          now: it is shown once, and the server keeps only its hash.
        </p>
        <pre className="overflow-x-auto rounded-lg bg-background px-3 py-2 font-mono text-xs select-all">
          {state.token}
        </pre>
        <p className="text-muted">
          To let your own Claude Code work the tree as you:
        </p>
        <pre className="overflow-x-auto rounded-lg bg-background px-3 py-2 font-mono text-xs select-all">
          {`claude mcp add --transport http zeenly ${mcpUrl} --header "Authorization: Bearer ${state.token}"`}
        </pre>
      </div>
    );
  }
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <div className="space-y-1">
        <label htmlFor="label" className="block text-sm font-medium">
          What it&apos;s for
        </label>
        <input
          id="label"
          name="label"
          maxLength={80}
          placeholder="my laptop"
          className="rounded-lg border border-line bg-surface px-3 py-2 outline-none focus:border-accent"
        />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-60"
      >
        {pending ? "Minting…" : "Mint a token"}
      </button>
      {state.error && (
        <p className="w-full text-sm text-negative">{state.error}</p>
      )}
    </form>
  );
}
