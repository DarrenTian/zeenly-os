"use client";

import { useActionState } from "react";

import { signInAction, type SignInState } from "./actions";

export function SignInForm() {
  const [state, action, pending] = useActionState<SignInState, FormData>(
    signInAction,
    {},
  );
  return (
    <form action={action} className="space-y-3">
      <label htmlFor="password" className="block text-sm font-medium">
        Password
      </label>
      <input
        id="password"
        name="password"
        type="password"
        required
        autoComplete="current-password"
        aria-describedby={state.error ? "password-error" : undefined}
        className="w-full rounded-lg border border-line bg-surface px-3 py-2 outline-none focus:border-accent"
      />
      {state.error && (
        <p id="password-error" className="text-sm text-negative">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-foreground px-4 py-2 font-medium text-background hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
