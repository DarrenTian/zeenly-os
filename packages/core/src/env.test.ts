import { describe, expect, it } from "vitest";

import { parseEnv } from "./env";

describe("parseEnv", () => {
  it.each([
    "postgres://user:pass@localhost:5432/app",
    "postgresql://user:pass@db.example.supabase.co:6543/postgres",
  ])("accepts %j", (url) => {
    expect(parseEnv({ DATABASE_URL: url })).toEqual({ DATABASE_URL: url });
  });

  it("falls back to Vercel's prefixed Neon variable", () => {
    const url = "postgresql://u:p@ep-x.neon.tech/neondb?sslmode=require";
    expect(parseEnv({ STORAGE_DATABASE_URL: url })).toEqual({
      DATABASE_URL: url,
    });
    expect(
      parseEnv({ DATABASE_URL: "postgres://a@b/c", STORAGE_DATABASE_URL: url }),
    ).toEqual({ DATABASE_URL: "postgres://a@b/c" });
  });

  it("drops client-only parameters and keeps the rest", () => {
    expect(
      parseEnv({
        DATABASE_URL:
          "postgresql://u:p@ep-x.neon.tech/neondb?sslmode=require&channel_binding=require",
      }),
    ).toEqual({
      DATABASE_URL: "postgresql://u:p@ep-x.neon.tech/neondb?sslmode=require",
    });
  });

  it("names the missing variable", () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it.each(["not a url", "mysql://user@localhost/app"])("rejects %j", (url) => {
    expect(() => parseEnv({ DATABASE_URL: url })).toThrow(/DATABASE_URL/);
  });
});
