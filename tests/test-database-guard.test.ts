import { describe, it, expect, afterEach, vi } from "vitest";
import { assertThrowawayDatabase, assertThrowawayTarget, classifyThrowawayDatabase, TestDatabaseRefused } from "../scripts/test-database-guard";

afterEach(() => vi.unstubAllEnvs());

const loopback = "postgresql://127.0.0.1:55432/nova_alert_race";

describe("throwaway database target", () => {
  it.each([
    "postgresql://127.0.0.1:55432/nova_alert_race",
    "postgresql://localhost/nova_alert_race",
    "postgresql://[::1]:55432/nova_alert_race",
    "postgres://nova@127.0.0.1/nova_alert_race"
  ])("allows %s when the process is demo and AI is off", url => {
    expect(() => assertThrowawayTarget({ mode: "demo", databaseUrl: url, aiEnabled: false })).not.toThrow();
  });
  it("refuses a remote database host before any connection", () => {
    expect(() => assertThrowawayTarget({ mode: "demo", databaseUrl: "postgresql://db.internal:5432/nova", aiEnabled: false })).toThrow(TestDatabaseRefused);
    expect(() => assertThrowawayTarget({ mode: "demo", databaseUrl: "postgresql://db.internal:5432/nova", aiEnabled: false })).toThrow(/loopback/);
  });
  it("refuses a database URL with no host", () => {
    expect(() => assertThrowawayTarget({ mode: "demo", databaseUrl: "postgresql:///nova", aiEnabled: false })).toThrow(/loopback/);
  });
  it("refuses service mode", () => {
    expect(() => assertThrowawayTarget({ mode: "service", databaseUrl: loopback, aiEnabled: false })).toThrow(/NOVA_MODE is not demo/);
  });
  it("refuses when AI is enabled", () => {
    expect(() => assertThrowawayTarget({ mode: "demo", databaseUrl: loopback, aiEnabled: true })).toThrow(/AI is enabled/);
  });
});

describe("throwaway database classification", () => {
  it("allows an empty database to be initialised", () => {
    expect(classifyThrowawayDatabase([], null, "CN")).toBe("initialize");
  });
  it("allows an existing demo classification in the same region", () => {
    expect(classifyThrowawayDatabase(["deployment_settings", "users"], { region: "CN", mode: "demo" }, "CN")).toBe("ready");
  });
  it("refuses a service classification", () => {
    expect(() => classifyThrowawayDatabase(["deployment_settings", "users"], { region: "CN", mode: "service" }, "CN")).toThrow(/not classified demo/);
  });
  it("refuses an unknown or missing classification on a non-empty database", () => {
    expect(() => classifyThrowawayDatabase(["deployment_settings"], { region: "CN", mode: null }, "CN")).toThrow(/not classified demo/);
    expect(() => classifyThrowawayDatabase(["deployment_settings"], { region: "CN", mode: "pilot" }, "CN")).toThrow(/not classified demo/);
    expect(() => classifyThrowawayDatabase(["users", "families"], null, "CN")).toThrow(/no demo classification/);
  });
  it("refuses a demo database for a different region", () => {
    expect(() => classifyThrowawayDatabase(["deployment_settings"], { region: "HK", mode: "demo" }, "CN")).toThrow(/different region/);
  });
});

describe("assertThrowawayDatabase", () => {
  function stubEnv(over: Record<string, string> = {}) {
    vi.stubEnv("NOVA_REGION", "CN");
    vi.stubEnv("NOVA_MODE", "demo");
    vi.stubEnv("DATABASE_URL", loopback);
    vi.stubEnv("NOVA_PUBLIC_URL", "http://127.0.0.1:3199");
    vi.stubEnv("NOVA_REPORT_DIR", "/tmp/nova-alert-race-reports");
    vi.stubEnv("NOVA_REPORT_KEY", "0".repeat(64));
    vi.stubEnv("NOVA_AI_ENABLED", "false");
    for (const [key, value] of Object.entries(over)) vi.stubEnv(key, value);
  }
  function client(responder: (sql: string) => { rows: Record<string, unknown>[] }) {
    const sqls: string[] = [];
    return { sqls, query: async (sql: string) => { sqls.push(sql); return responder(sql); } };
  }

  it("does not query when the process is not a demo", async () => {
    stubEnv({ NOVA_MODE: "service", NOVA_PUBLIC_URL: "https://127.0.0.1" });
    const db = client(() => { throw new Error("should not query"); });
    await expect(assertThrowawayDatabase(db)).rejects.toThrow(/NOVA_MODE is not demo/);
    expect(db.sqls).toEqual([]);
  });
  it("does not query when AI is enabled", async () => {
    stubEnv({
      NOVA_AI_ENABLED: "true",
      NOVA_AI_BASE_URL: "https://api.deepseek.com",
      NOVA_AI_API_KEY: "synthetic",
      NOVA_AI_MODEL: "deepseek-flash",
      NOVA_AI_DEPLOYMENT_SCOPE: "CN"
    });
    const db = client(() => { throw new Error("should not query"); });
    await expect(assertThrowawayDatabase(db)).rejects.toThrow(/AI is enabled/);
    expect(db.sqls).toEqual([]);
  });
  it("only reads an empty database and reports that it may be initialised", async () => {
    stubEnv();
    const db = client(sql => sql.includes("pg_tables") ? { rows: [] } : { rows: [] });
    await expect(assertThrowawayDatabase(db)).resolves.toBe("initialize");
    expect(db.sqls.every(sql => sql.trimStart().startsWith("SELECT"))).toBe(true);
  });
  it("only reads a demo database", async () => {
    stubEnv();
    const db = client(sql => sql.includes("pg_tables")
      ? { rows: [{ tablename: "deployment_settings" }, { tablename: "users" }] }
      : { rows: [{ region: "CN", mode: "demo" }] });
    await expect(assertThrowawayDatabase(db)).resolves.toBe("ready");
    expect(db.sqls.every(sql => sql.trimStart().startsWith("SELECT"))).toBe(true);
    expect(db.sqls.some(sql => /insert|update|delete|create|alter/i.test(sql))).toBe(false);
  });
  it("refuses a service-classified database after read-only checks", async () => {
    stubEnv();
    const db = client(sql => sql.includes("pg_tables")
      ? { rows: [{ tablename: "deployment_settings" }, { tablename: "users" }] }
      : { rows: [{ region: "CN", mode: "service" }] });
    await expect(assertThrowawayDatabase(db)).rejects.toThrow(/not classified demo/);
    expect(db.sqls.every(sql => sql.trimStart().startsWith("SELECT"))).toBe(true);
  });
});
