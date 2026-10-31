"use server";

import { redirect } from "next/navigation";

import { listUnits, TreeError } from "@zeenly-os/core";

import { requireSignIn } from "@/lib/auth";
import { createCompany } from "@/lib/template";

export type SetupState = { error?: string };

export async function setupAction(
  _prev: SetupState,
  data: FormData,
): Promise<SetupState> {
  await requireSignIn();
  if ((await listUnits()).length) redirect("/");
  const company = String(data.get("company") ?? "").trim();
  const person = String(data.get("person") ?? "").trim();
  const roles = data.getAll("roles").map(String);
  if (!company) return { error: "Give the company a name." };
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(person)) {
    return {
      error:
        "Your name is 2–40 lower-case letters, digits and dashes, starting with a letter.",
    };
  }
  try {
    await createCompany({ company, person, roles });
  } catch (err) {
    if (err instanceof TreeError) return { error: err.message };
    throw err;
  }
  redirect("/");
}
