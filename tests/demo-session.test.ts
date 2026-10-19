import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import type { PoolClient } from "pg";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
import { query, transaction } from "../src/lib/db";
import { hashToken, setDemoSession } from "../src/lib/auth";

const USER_ID = "11111111-2222-4333-8444-555555555555";
let account: { id: string; region: "CN" | "HK"; demo: boolean; disabled: boolean } | null;
let beforeGuard: () => void;
let failCommit: boolean;
let inserted: unknown[][];
const client = { query: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NOVA_AUTH_PROVIDER", "local"); vi.stubEnv("NOVA_REGION", "CN"); vi.stubEnv("NOVA_MODE", "demo");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/nova"); vi.stubEnv("NOVA_PUBLIC_URL", "http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR", "work/test-private"); vi.stubEnv("NOVA_REPORT_KEY", "0".repeat(64));
  account = { id: USER_ID, region: "CN", demo: true, disabled: false };
  beforeGuard = () => {}; failCommit = false; inserted = [];
  vi.mocked(query).mockImplementation(async (sql, values = []) => {
    if (!sql.startsWith("INSERT INTO sessions")) throw new Error("Unexpected nontransactional query");
    beforeGuard();
    if (!account || account.id !== values[1] || account.region !== values[2] || account.disabled) return [];
    inserted.push(values);
    return [{ token_hash: values[0] }];
  });
  client.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
    if (sql.includes("FROM users") && sql.includes("FOR UPDATE")) {
      const rows = account && account.id === values[0] ? [{ id: account.id }] : [];
      beforeGuard();
      return { rows };
    }
    if (sql.startsWith("SELECT")) {
      expect(sql).toContain("region=$2");
      expect(sql).toContain("AND demo AND NOT disabled");
      return { rows: account && account.id === values[0] && account.region === values[1] && account.demo && !account.disabled ? [{ id: account.id }] : [] };
    }
    if (sql.startsWith("INSERT INTO sessions")) { inserted.push(values); return { rows: [] }; }
    throw new Error("Unexpected transaction query");
  });
  vi.mocked(transaction).mockImplementation(async fn => {
    const value = await fn(client as unknown as PoolClient);
    if (failCommit) throw new Error("Synthetic commit failure");
    return value;
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("demo session authorization at issuance", () => {
  it.each(["private", "disabled", "foreign-region"] as const)("rejects an account changed to %s before the fresh guard", async change => {
    beforeGuard = () => {
      if (change === "private") account!.demo = false;
      if (change === "disabled") account!.disabled = true;
      if (change === "foreign-region") account!.region = "HK";
    };
    const response = NextResponse.json({ ok: true });
    await expect(setDemoSession(response, USER_ID)).rejects.toMatchObject({ status: 403, code: "INVALID_DEMO_ACCOUNT" });
    expect(inserted).toEqual([]);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
  it("rejects an account deleted before the user lock", async () => {
    account = null;
    const response = NextResponse.json({ ok: true });
    await expect(setDemoSession(response, USER_ID)).rejects.toMatchObject({ code: "INVALID_DEMO_ACCOUNT" });
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(inserted).toEqual([]);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
  it.each(["CN", "HK"] as const)("issues an enabled %s demo account with the existing cookie policy", async region => {
    vi.stubEnv("NOVA_REGION", region); account!.region = region;
    const response = NextResponse.json({ ok: true });
    await setDemoSession(response, USER_ID);
    expect(query).not.toHaveBeenCalled();
    expect(client.query.mock.calls[0]).toEqual(["SELECT id FROM users WHERE id=$1 FOR UPDATE", [USER_ID]]);
    expect(client.query.mock.calls[1][1]).toEqual([USER_ID, region]);
    expect(client.query.mock.calls[2][0]).toContain("INSERT INTO sessions");
    const cookie = response.cookies.get(`nova_${region.toLowerCase()}_session`)!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "lax", maxAge: 43200, path: "/", secure: false });
    expect(cookie.value).toMatch(/^[a-f0-9]{96}$/);
    expect(inserted).toEqual([[hashToken(cookie.value), USER_ID, region]]);
  });
  it("does not issue a demo session in service mode", async () => {
    vi.stubEnv("NOVA_MODE", "service"); vi.stubEnv("NOVA_PUBLIC_URL", "https://synthetic.example");
    const response = NextResponse.json({ ok: true });
    await expect(setDemoSession(response, USER_ID)).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(transaction).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });
  it("does not issue a local demo session in Clerk mode", async () => {
    vi.stubEnv("NOVA_AUTH_PROVIDER", "clerk");
    const response = NextResponse.json({ ok: true });
    await expect(setDemoSession(response, USER_ID)).rejects.toMatchObject({ code: "AUTH_PROVIDER_MISMATCH" });
    expect(transaction).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });
  it("does not send a cookie when session commit fails", async () => {
    failCommit = true;
    const response = NextResponse.json({ ok: true });
    await expect(setDemoSession(response, USER_ID)).rejects.toThrow("Synthetic commit failure");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
