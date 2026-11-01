import { resolveToken } from "@zeenly-os/core";

import { runPass } from "@/lib/scheduler";

/**
 * One scheduler pass now, for `zeenly-os run`: every unit with something to
 * do runs once. A person's token is needed; a unit's agent can't wake the
 * others.
 */
export async function POST(request: Request) {
  const given = /^Bearer\s+(\S+)$/i.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];
  const actor = given ? await resolveToken(given) : null;
  if (actor?.kind !== "human") {
    return Response.json(
      { error: "A person's token is needed: the one in ZEENLY_OS_DATA/token" },
      { status: 401 },
    );
  }
  const lines: string[] = [];
  const result = await runPass(undefined, (line) => lines.push(line));
  return Response.json({ ...result, log: lines });
}
