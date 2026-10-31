import { describe, expect, it } from "vitest";

import { createTestDb } from "../test-db";
import { type Actor, SCHEDULER } from "./actors";
import { Forbidden } from "./errors";
import { listEvents } from "./events";
import { issueToken, listTokens, resolveToken, revokeToken } from "./tokens";

const FOUNDER: Actor = { kind: "human", id: "founder" };
const T0 = new Date("2026-10-31T09:00:00Z");

describe("tokens", () => {
  it("act as one actor, expire, and are shown once", async () => {
    const db = await createTestDb();
    const issued = await issueToken(
      { actor: { kind: "unit", id: "eng" }, label: "run 1", ttlMs: 3600_000 },
      SCHEDULER,
      { now: T0 },
      db,
    );
    expect(issued.token).toMatch(/^zos_[0-9a-f]{48}$/);
    expect(issued.expiresAt).toEqual(new Date(T0.getTime() + 3600_000));
    expect(await resolveToken(issued.token, { now: T0 }, db)).toEqual({
      kind: "unit",
      id: "eng",
    });
    expect(
      await resolveToken(
        issued.token,
        { now: new Date(T0.getTime() + 3600_000) },
        db,
      ),
    ).toBeNull();
    expect(await resolveToken("zos_nope", { now: T0 }, db)).toBeNull();
    expect(await resolveToken("", { now: T0 }, db)).toBeNull();

    const info = await listTokens(db);
    expect(info).toHaveLength(1);
    expect(info[0]).not.toHaveProperty("token");
    expect(info[0].actor).toEqual({ kind: "unit", id: "eng" });
    // The event names the token, never the secret.
    const [event] = await listEvents({ unit: "eng" }, db);
    expect(event.what).toBe("token.issued");
    expect(JSON.stringify(event.after)).not.toContain(issued.token);
  });

  it("are minted by people and the scheduler, revoked by them, never by a unit's agent", async () => {
    const db = await createTestDb();
    const mine = await issueToken(
      { actor: FOUNDER, label: "laptop" },
      FOUNDER,
      { now: T0 },
      db,
    );
    expect(mine.expiresAt).toBeNull();
    expect(await resolveToken(mine.token, { now: T0 }, db)).toEqual(FOUNDER);
    await expect(
      issueToken({ actor: FOUNDER }, { kind: "unit", id: "eng" }, {}, db),
    ).rejects.toThrow(Forbidden);
    await expect(
      issueToken({ actor: SCHEDULER }, FOUNDER, {}, db),
    ).rejects.toThrow(/without a token/);
    await expect(
      revokeToken(mine.id, { kind: "unit", id: "eng" }, {}, db),
    ).rejects.toThrow(Forbidden);
    await revokeToken(mine.id, FOUNDER, { now: T0 }, db);
    expect(await resolveToken(mine.token, { now: T0 }, db)).toBeNull();
    expect((await listTokens(db))[0].revokedAt).toEqual(T0);
    await expect(revokeToken("nope", FOUNDER, {}, db)).rejects.toThrow(
      /No token/,
    );
  });
});
