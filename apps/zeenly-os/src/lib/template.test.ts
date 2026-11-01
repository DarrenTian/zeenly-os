import { createTestDb } from "@zeenly-os/core/testing";
import { getUnitDoc, listUnits, personOf, unitView } from "@zeenly-os/core";
import { describe, expect, it } from "vitest";

import { createCompany, ROLES, slugOf } from "./template";

describe("the starter company", () => {
  it("is a steered root the person owns, with the picked roles on autopilot under it", async () => {
    const db = await createTestDb();
    const made = await createCompany(
      {
        company: "Acme Tools",
        person: "ada",
        roles: ["engineering", "finance"],
      },
      db,
    );
    expect(made).toEqual({
      root: "acme-tools",
      person: { kind: "human", id: "ada" },
      roles: ["engineering", "finance"],
    });
    const all = await listUnits(db);
    expect(all.map((u) => [u.id, u.parentId, u.mode])).toEqual([
      ["acme-tools", null, "steer"],
      ["engineering", "acme-tools", "autopilot"],
      ["finance", "acme-tools", "autopilot"],
    ]);
    expect(personOf(all, "finance")).toBe("ada");
    expect(
      (await getUnitDoc({ unit: "engineering", name: "charter" }, db))?.body,
    ).toContain("## Owns");
    expect((await unitView("finance", db)).ancestors[0].charter).toContain(
      "climbs back up to ada",
    );
  });

  it("names the root from the company, and has a charter for every role", () => {
    expect(slugOf("Acme Tools")).toBe("acme-tools");
    expect(slugOf("  Ünïcode & Co.  ")).toBe("n-code-co");
    expect(slugOf("42")).toBe("company");
    expect(slugOf("x")).toBe("company");
    for (const role of ROLES) {
      expect(role.charter).toContain("## Owns");
      expect(role.charter).toContain("## Doesn't own");
    }
  });
});
