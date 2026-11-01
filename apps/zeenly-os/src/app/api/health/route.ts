import { health } from "@zeenly-os/core";

// Asked of the live database every time, never from a cache.
export const dynamic = "force-dynamic";

/**
 * GET /api/health: 200 when the server can work (the database answers and
 * has every migration this code needs), 503 with what's wrong when not.
 * No token: it says nothing about the company.
 */
export async function GET() {
  const result = await health();
  return Response.json(result, {
    status: result.ok ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
