/**
 * Runs once when the server starts. The server owns the database (the
 * embedded one allows a single process), so this is where it is migrated,
 * where the command line's token is kept current, and where the scheduler
 * lives unless ZEENLY_OS_SCHEDULER=off.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { databaseInfo, migrateDb } = await import("@zeenly-os/core");
  await migrateDb();
  const info = databaseInfo();
  console.log(`zeenly-os · ${info.kind} database at ${info.where}`);
  const { ensureLocalToken } = await import("@/lib/local-token");
  await ensureLocalToken();
  if (process.env.ZEENLY_OS_SCHEDULER !== "off") {
    const { startLoop } = await import("@/lib/scheduler");
    startLoop();
  }
}
