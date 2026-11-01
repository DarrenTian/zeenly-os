import type { Metadata } from "next";

import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage() {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">zeenly-os</h1>
      <p className="mt-1 text-sm text-muted">
        This server has a password (ZEENLY_OS_PASSWORD). Enter it once.
      </p>
      <div className="mt-6">
        <SignInForm />
      </div>
    </main>
  );
}
