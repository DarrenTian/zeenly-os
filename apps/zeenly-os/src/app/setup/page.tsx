import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { listUnits } from "@zeenly-os/core";

import { requireSignIn } from "@/lib/auth";
import { ROLES } from "@/lib/template";

import { SetupForm } from "./setup-form";

// Reads the database on every request; there is nothing to prerender.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Set up your company" };

export default async function SetupPage() {
  await requireSignIn();
  if ((await listUnits()).length) redirect("/");
  return (
    <main className="mx-auto w-full max-w-lg flex-1 px-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">
        Set up your company
      </h1>
      <p className="mt-2 text-muted">
        A company is a tree of roles, each run by an agent. You steer the root;
        the roles below it work and bring you what they can&apos;t decide. Pick
        the roles to start with; you can change everything later.
      </p>
      <div className="mt-8">
        <SetupForm
          roles={ROLES.map((r) => ({
            id: r.id,
            name: r.name,
            summary: r.summary,
          }))}
        />
      </div>
    </main>
  );
}
