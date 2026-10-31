/**
 * Runs once when the server starts: applies any migrations the database
 * hasn't had, so a fresh install or an upgrade needs no separate step.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { migrateDb } = await import("@zeenly-os/core");
  await migrateDb();
}
