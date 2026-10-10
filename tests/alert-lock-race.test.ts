import { describe, it, expect } from "vitest";
import { raceFixture } from "../scripts/alert-lock-race";

describe("alert lock race fixtures", () => {
  it.each(["CN", "HK"] as const)("keeps every synthetic row in %s when that is the configured region", region => {
    const fixture = raceFixture(region);
    expect(fixture.region).toBe(region);
    for (const person of [fixture.oldStaff, fixture.newStaff, fixture.admin]) {
      expect(person.region).toBe(region);
    }
    expect([fixture.oldStaff.role, fixture.newStaff.role, fixture.admin.role]).toEqual(["staff", "staff", "admin"]);
  });
});
