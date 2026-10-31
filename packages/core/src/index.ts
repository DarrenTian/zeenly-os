// The kernel: a company as a tree of roles, each run by an agent. Everything
// here reads and writes the database, so import it on a server only.
export { db, type Database } from "./db";
export * as schema from "./db/schema";
export { env, parseEnv, type Env } from "./env";
export * from "./tree";
