"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { COOKIE, cookieValue, password, sameString } from "@/lib/auth";

export type SignInState = { error?: string };

export async function signInAction(
  _prev: SignInState,
  data: FormData,
): Promise<SignInState> {
  const secret = password();
  if (!secret) redirect("/");
  const given = data.get("password");
  if (typeof given !== "string" || !sameString(given.trim(), secret)) {
    return { error: "That password isn't right." };
  }
  (await cookies()).set(COOKIE, cookieValue(secret), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  redirect("/");
}
