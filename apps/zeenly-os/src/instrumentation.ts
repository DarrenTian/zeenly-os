/**
 * Runs once when the server starts. The server owns the database (the
 * embedded one allows a single process), so this is where it is migrated
 * (unless ZEENLY_OS_MIGRATE_ON_START=off, for deploys that migrate first
 * with `zeenly-os migrate`), where the command line's token is kept
 * current, and where the scheduler lives unless ZEENLY_OS_SCHEDULER=off.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { checkSchema, databaseInfo, migrateDb } =
    await import("@zeenly-os/core");
  const info = databaseInfo();
  console.log(`zeenly-os · ${info.kind} database at ${info.where}`);
  if (process.env.ZEENLY_OS_MIGRATE_ON_START !== "off") {
    for (const tag of await migrateDb()) console.log(`  applied ${tag}`);
  }
  const status = await checkSchema();
  if (status.state === "behind") {
    // Pages still read; every write says to migrate. Nothing here would
    // write anything worth having until then.
    console.error(
      `zeenly-os · the database is missing ${status.missing.join(", ")}: nothing can be written until \`zeenly-os migrate\` runs.`,
    );
    return;
  }
  const { ensureLocalToken } = await import("@/lib/local-token");
  await ensureLocalToken();
  if (process.env.ZEENLY_OS_SCHEDULER !== "off") {
    const { startLoop } = await import("@/lib/scheduler");
    startLoop();
  }
}
