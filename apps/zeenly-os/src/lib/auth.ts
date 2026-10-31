import { createHash } from "node:crypto";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

/**
 * Two ways to run. On your own machine there is no sign-in: the pages are
 * yours, like any local tool. Set ZEENLY_OS_PASSWORD when the server is on
 * the internet, and the pages ask for it once per browser.
 */
export const COOKIE = "zeenly_os_session";

/** ZEENLY_OS_PASSWORD, trimmed of the spaces a paste can leave; undefined when unset. */
export function password(): string | undefined {
  return process.env.ZEENLY_OS_PASSWORD?.trim() || undefined;
}

/** Sends the browser to /sign-in unless no password is set or its cookie is right. */
export async function requireSignIn(): Promise<void> {
  const secret = password();
  if (!secret) return;
  const given = (await cookies()).get(COOKIE)?.value;
  if (!given || !sameString(given, cookieValue(secret))) redirect("/sign-in");
}

/** What the cookie holds: a digest, so the password itself never travels back. */
export function cookieValue(secret: string): string {
  return createHash("sha256").update(`zeenly-os:${secret}`).digest("hex");
}

/** Compares without stopping at the first difference, so timing leaks nothing. */
export function sameString(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
