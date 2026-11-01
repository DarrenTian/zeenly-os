import { describe, expect, it } from "vitest";

import { parseEnv } from "./env";

describe("parseEnv", () => {
  it.each([
    "postgres://user:pass@localhost:5432/app",
    "postgresql://user:pass@db.example.supabase.co:6543/postgres",
  ])("accepts %j", (url) => {
    expect(parseEnv({ DATABASE_URL: url }).DATABASE_URL).toBe(url);
  });

  it("needs nothing: without a database it keeps its data under ~/.zeenly-os", () => {
    const parsed = parseEnv({});
    expect(parsed.DATABASE_URL).toBeUndefined();
    expect(parsed.ZEENLY_OS_DATA).toMatch(/[\\/]\.zeenly-os$/);
    expect(parseEnv({ ZEENLY_OS_DATA: " /srv/zeenly " }).ZEENLY_OS_DATA).toBe(
      "/srv/zeenly",
    );
    expect(parseEnv({ DATABASE_URL: "" }).DATABASE_URL).toBeUndefined();
  });

  it("falls back to Vercel's prefixed Neon variable", () => {
    const url = "postgresql://u:p@ep-x.neon.tech/neondb?sslmode=require";
    expect(parseEnv({ STORAGE_DATABASE_URL: url }).DATABASE_URL).toBe(url);
    expect(
      parseEnv({ DATABASE_URL: "postgres://a@b/c", STORAGE_DATABASE_URL: url })
        .DATABASE_URL,
    ).toBe("postgres://a@b/c");
  });

  it("drops client-only parameters and keeps the rest", () => {
    expect(
      parseEnv({
        DATABASE_URL:
          "postgresql://u:p@ep-x.neon.tech/neondb?sslmode=require&channel_binding=require",
      }).DATABASE_URL,
    ).toBe("postgresql://u:p@ep-x.neon.tech/neondb?sslmode=require");
  });

  it.each(["not a url", "mysql://user@localhost/app"])("rejects %j", (url) => {
    expect(() => parseEnv({ DATABASE_URL: url })).toThrow(/DATABASE_URL/);
  });
});
