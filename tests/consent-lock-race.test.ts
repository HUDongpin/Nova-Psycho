import { afterEach, describe, expect, it, vi } from "vitest";
import { assertConsentRaceTarget, raceFixture } from "../scripts/consent-lock-race";
import { TestDatabaseRefused } from "../scripts/test-database-guard";

afterEach(() => vi.unstubAllEnvs());

function env(over: Record<string, string> = {}) {
  vi.stubEnv("NOVA_REGION", "CN");
  vi.stubEnv("NOVA_MODE", "demo");
  vi.stubEnv("DATABASE_URL", "postgresql://127.0.0.1:55432/nova_consent_race");
  vi.stubEnv("NOVA_PUBLIC_URL", "http://127.0.0.1:3199");
  vi.stubEnv("NOVA_REPORT_DIR", "/tmp/nova-consent-race-reports");
  vi.stubEnv("NOVA_REPORT_KEY", "0".repeat(64));
  vi.stubEnv("NOVA_AI_ENABLED", "false");
  for (const [key, value] of Object.entries(over)) vi.stubEnv(key, value);
}

describe("consent race target", () => {
  it("accepts the throwaway database before any connection", () => {
    env();
    expect(() => assertConsentRaceTarget()).not.toThrow();
  });
  it("refuses a loopback URL whose host query parameter retargets the connection", () => {
    env({ DATABASE_URL: "postgresql://127.0.0.1:55432/nova_consent_race?host=example.invalid" });
    expect(() => assertConsentRaceTarget()).toThrow(TestDatabaseRefused);
    expect(() => assertConsentRaceTarget()).toThrow(/retarget/);
  });
  it("refuses another loopback port before connecting", () => {
    env({ DATABASE_URL: "postgresql://127.0.0.1:5432/nova_consent_race" });
    expect(() => assertConsentRaceTarget()).toThrow(/55432/);
  });
  it("builds fixtures for the configured region, including HK", () => {
    expect(raceFixture("HK").oldStaff.region).toBe("HK");
    expect(raceFixture("CN").parent.region).toBe("CN");
    const people = raceFixture("HK");
    for (const person of [people.oldStaff, people.newStaff, people.admin, people.parent]) expect(person.region).toBe("HK");
  });
});
