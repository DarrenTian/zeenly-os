import { handleMcp, resolveToken } from "@zeenly-os/core";

/**
 * The tree's MCP server (streamable HTTP, stateless): POST one JSON-RPC
 * message with a token as a bearer token, get one JSON reply. The token
 * says who is calling: a unit's agent (`zeenly-os run` mints one for each
 * session) or a person (`zeenly-os token`).
 */
export async function POST(request: Request) {
  const given = /^Bearer\s+(\S+)$/i.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];
  const actor = given ? await resolveToken(given) : null;
  if (!actor) {
    return Response.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32001,
          message:
            "Send a token as a bearer token: one from `zeenly-os token`, or the one `zeenly-os run` gave this unit's session",
        },
      },
      { status: 401 },
    );
  }
  let message: unknown;
  try {
    message = await request.json();
  } catch {
    return Response.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Send JSON" },
      },
      { status: 400 },
    );
  }
  if (Array.isArray(message)) {
    return Response.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Send one message at a time" },
      },
      { status: 400 },
    );
  }
  const reply = await handleMcp(message, { actor });
  // A notification gets no reply.
  return reply ? Response.json(reply) : new Response(null, { status: 202 });
}

/** No server-to-client stream: every reply comes back on its POST. */
export function GET() {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}
