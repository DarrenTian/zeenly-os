"use server";

import { revalidatePath } from "next/cache";

import { issueToken, revokeToken, TreeError } from "@zeenly-os/core";

import { currentPerson } from "@/lib/person";

export type TokenState = {
  /** The secret, shown once; the server keeps only its hash. */
  token?: string;
  label?: string;
  error?: string;
};

/** Mints a token that acts as the signed-in person, for their own Claude. */
export async function mintTokenAction(
  _prev: TokenState,
  data: FormData,
): Promise<TokenState> {
  const person = await currentPerson();
  if (!person) return { error: "Set up the company first." };
  const label = String(data.get("label") ?? "").trim() || "my claude";
  try {
    const issued = await issueToken(
      { actor: person, label, ttlMs: null },
      person,
    );
    revalidatePath("/token");
    return { token: issued.token, label };
  } catch (err) {
    if (err instanceof TreeError) return { error: err.message };
    throw err;
  }
}

export async function revokeTokenAction(data: FormData): Promise<void> {
  const person = await currentPerson();
  if (!person) return;
  await revokeToken(String(data.get("id") ?? ""), person);
  revalidatePath("/token");
}
