"use client";

import { useActionState } from "react";

import { setupAction, type SetupState } from "./actions";

export function SetupForm({
  roles,
}: {
  roles: { id: string; name: string; summary: string }[];
}) {
  const [state, action, pending] = useActionState<SetupState, FormData>(
    setupAction,
    {},
  );
  const field =
    "w-full rounded-lg border border-line bg-surface px-3 py-2 outline-none focus:border-accent";
  return (
    <form action={action} className="space-y-6">
      <div className="space-y-1">
        <label htmlFor="company" className="block text-sm font-medium">
          Company
        </label>
        <input
          id="company"
          name="company"
          required
          maxLength={80}
          placeholder="Acme Tools"
          className={field}
        />
      </div>
      <div className="space-y-1">
        <label htmlFor="person" className="block text-sm font-medium">
          Your name
        </label>
        <input
          id="person"
          name="person"
          required
          maxLength={40}
          placeholder="ada"
          pattern="[a-z][a-z0-9-]{1,39}"
          className={field}
        />
        <p className="text-xs text-subtle">
          Lower-case letters, digits and dashes. Decisions and guidelines are
          recorded under this name.
        </p>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Roles to start with</legend>
        {roles.map((r) => (
          <label
            key={r.id}
            className="flex items-start gap-3 rounded-lg border border-line bg-surface px-3 py-2"
          >
            <input
              type="checkbox"
              name="roles"
              value={r.id}
              defaultChecked
              className="mt-1"
            />
            <span>
              <span className="font-medium">{r.name}</span>
              <span className="block text-sm text-muted">{r.summary}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {state.error && <p className="text-sm text-negative">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-foreground px-4 py-2 font-medium text-background hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Creating…" : "Create the company"}
      </button>
    </form>
  );
}
