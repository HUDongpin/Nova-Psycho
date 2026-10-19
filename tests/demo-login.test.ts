import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));

import { query, transaction } from "../src/lib/db";
import { actorOf, setPasswordSession } from "../src/lib/auth";
import { GET, POST } from "../src/app/api/[...path]/route";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const STAFF_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";

function stub(mode: "demo" | "service") {
  vi.stubEnv("NOVA_REGION", "CN");
  vi.stubEnv("NOVA_MODE", mode);
  vi.stubEnv("NOVA_AUTH_PROVIDER", "local");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_PUBLIC_URL", mode === "demo" ? "http://127.0.0.1:3100" : "https://nova.example.invalid");
  vi.stubEnv("NOVA_REPORT_DIR", "work/test-private");
  vi.stubEnv("NOVA_REPORT_KEY", "0".repeat(64));
  vi.stubEnv("NOVA_TEST_ACCOUNT_USERNAMES", "");
}
function origin() {
  return process.env.NOVA_MODE === "demo" ? "http://127.0.0.1:3100" : "https://nova.example.invalid";
}
function postDemo(body: string) {
  const base = origin();
  return POST(new Request(`${base}/api/auth/demo`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body,
  }), { params: Promise.resolve({ path: ["auth", "demo"] }) });
}

function seededDemo(id: string) {
  return id === ADMIN_ID || id === STAFF_ID ? [{ id }] : [];
}

beforeEach(() => {
  vi.clearAllMocks();
  stub("demo");
  vi.mocked(query).mockImplementation(async (sql: string, params: unknown[] = []) => {
    const text = String(sql);
    if (text.includes("INSERT INTO sessions")) return [{ token_hash: "x" }];
    // The actor lock is a separate statement from the demo recheck.
    if (text.includes("FOR UPDATE")) return seededDemo(String(params[0]));
    if (text.includes("WHERE id=$1") && text.includes(" AND demo") && text.includes("NOT disabled") && text.includes("region=$2")) {
      return seededDemo(String(params[0]));
    }
    if (text.startsWith("SELECT id,name,role FROM users WHERE demo AND region=$1")) {
      return [
        { id: ADMIN_ID, name: "Nova 管理员 · 演示", role: "admin" },
        { id: STAFF_ID, name: "陈老师 · 演示", role: "staff" },
      ];
    }
    return [];
  });
  // Session creation commits inside the user lock. Mirror those statements onto
  // query so the route still asserts the inserted account and not the raw cookie.
  vi.mocked(transaction).mockImplementation((async (fn: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => fn({
    query: async (sql: string, params: unknown[] = []) => ({ rows: await query(sql, params) }),
  })) as never);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/auth/demo", () => {
  it.each([
    ["admin", ADMIN_ID],
    ["staff", STAFF_ID],
  ] as const)("opens a session for the seeded %s account in demo mode", async (_role, accountId) => {
    const response = await postDemo(JSON.stringify({ accountId }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("nova_cn_session=");
    expect(cookie.toLowerCase()).not.toContain("secure");
    const lookup = vi.mocked(query).mock.calls.find(([sql]) => String(sql).includes("WHERE id=$1"));
    expect(String(lookup?.[0])).toContain("AND demo");
    expect(String(lookup?.[0])).toContain("NOT disabled");
    expect(lookup?.[1]).toEqual([accountId, "CN"]);
    const insert = vi.mocked(query).mock.calls.find(([sql]) => String(sql).includes("INSERT INTO sessions"));
    expect(insert?.[1]).toContain(accountId);
    expect(insert?.[1]).not.toContain(cookie);
  });

  it("refuses an account that is not an enabled demo user in this region", async () => {
    const response = await postDemo(JSON.stringify({ accountId: OTHER_ID }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_DEMO_ACCOUNT" });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(vi.mocked(query).mock.calls.some(([sql]) => String(sql).includes("INSERT INTO sessions"))).toBe(false);
  });

  it("refuses the endpoint in service mode before reading the body", async () => {
    stub("service");
    const response = await postDemo("not-json");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "NOT_FOUND" });
    expect(query).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("refuses the endpoint when Clerk owns authentication, even in demo mode", async () => {
    vi.stubEnv("NOVA_AUTH_PROVIDER", "clerk");
    const response = await postDemo(JSON.stringify({ accountId: ADMIN_ID }));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "NOT_FOUND" });
    expect(query).not.toHaveBeenCalled();
  });

  it("still validates the body once demo login is allowed", async () => {
    const response = await postDemo(JSON.stringify({ accountId: "not-a-uuid" }));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(query).not.toHaveBeenCalled();
  });
});

describe("demo account listing", () => {
  it("returns no demo accounts in service mode", async () => {
    stub("service");
    const response = await GET(new Request("https://nova.example.invalid/api/session"), { params: Promise.resolve({ path: ["session"] }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ mode: "service", demoAccounts: [] });
    expect(query).not.toHaveBeenCalled();
  });

  it("lists seeded demo accounts only in local demo mode", async () => {
    const response = await GET(new Request("http://127.0.0.1:3100/api/session"), { params: Promise.resolve({ path: ["session"] }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.mode).toBe("demo");
    expect(body.demoAccounts).toEqual([
      { id: ADMIN_ID, name: "Nova 管理员 · 演示", role: "admin" },
      { id: STAFF_ID, name: "陈老师 · 演示", role: "staff" },
    ]);
    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(String(sql)).toContain("WHERE demo");
    expect(String(sql)).toContain("NOT disabled");
    expect(params).toEqual(["CN"]);
  });
});

describe("seeded demo users have no password credential", () => {
  it("inserts demo users without a password hash", () => {
    const source = readFileSync(new URL("../scripts/setup.ts", import.meta.url), "utf8");
    const insert = source.match(/INSERT INTO users\(([^)]+)\) VALUES\([^)]+\)",\[a\.id/);
    expect(insert?.[1]).toBe("id,region,username,name,role,demo");
    expect(source).toContain('`demo_${a.key}`');
    for (const name of ["Nova 管理员 · 演示", "陈老师 · 演示", "林家长 · 演示", "林小禾 · 演示", "许老师 · 演示", "Nova 管理員 · 示範", "陳老師 · 示範"]) {
      expect(source).toContain(name);
    }
  });

  it("does not accept a password for a demo username in service mode", async () => {
    stub("service");
    const response = NextResponse.json({ ok: true });
    await expect(setPasswordSession(response, "demo_admin", "synthetic-long-password")).rejects.toMatchObject({ status: 401, code: "INVALID_CREDENTIALS" });
    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(String(sql)).toContain("OR NOT demo");
    expect(params?.[2]).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("does not accept a password when the seeded demo user has no hash, even in demo mode", async () => {
    vi.mocked(query).mockResolvedValueOnce([{ id: ADMIN_ID, password_hash: null }]);
    const response = NextResponse.json({ ok: true });
    await expect(setPasswordSession(response, "demo_admin", "synthetic-long-password")).rejects.toMatchObject({ status: 401, code: "INVALID_CREDENTIALS" });
    expect(transaction).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("does not resolve a demo session cookie in service mode", async () => {
    stub("service");
    const token = "a".repeat(96);
    const request = new Request("https://nova.example.invalid/api/session", { headers: { cookie: `nova_cn_session=${token}` } });
    await expect(actorOf(request, false)).resolves.toBeNull();
    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(String(sql)).toContain("OR NOT u.demo");
    expect(params?.[2]).toBe(false);
  });
});
