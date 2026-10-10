import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../src/domain/types";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../src/lib/auth", () => ({ audit: vi.fn(), hashPassword: vi.fn(async () => "synthetic-hash"), limitLogin: vi.fn(async () => undefined) }));

import { transaction } from "../src/lib/db";
import { limitLogin } from "../src/lib/auth";
import { createParentFamily, joinClerkStudent, joinFamily, joinWithCode, startParentCase } from "../src/lib/triad";

const parent = { parentName: "Synthetic parent", username: "synthetic.parent", password: "synthetic-password-1", relationship: "母亲" as const, childName: "Synthetic child", birthDate: "2014-06-01", grade: "初中" as const, accepted: true as const };
const joining = { code: "TOPE-A2B3C4D5", role: "student" as const, name: "Synthetic student", username: "synthetic.student", password: "synthetic-password-1" };
const actor: Actor = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Synthetic student", role: "student", region: "CN" };
const parentActor: Actor = { ...actor, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Synthetic parent", role: "parent" };
const principal = { subject: "user_synthetic", issuer: "https://synthetic.clerk.invalid", sessionId: "sess_synthetic", region: "CN" as const, emailVerified: true as const };
const familyInput = { requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", relationship: "母亲" as const, childName: "Synthetic child", birthDate: "2014-06-01", grade: "初中" as const, accepted: true as const };

const sql = vi.fn(async (text: string) => {
  if (text.startsWith("SELECT id FROM scales")) return { rows: [{ id: "growth-parent@1.2.0" }] };
  if (text.startsWith("SELECT id,birth_date FROM families")) return { rows: [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", birth_date: "2014-06-01" }] };
  if (text.startsWith("SELECT id FROM consents")) return { rows: [{ id: "consent" }] };
  return { rows: [] };
});

function stub(mode: "demo" | "service") {
  vi.stubEnv("NOVA_REGION", "CN");
  vi.stubEnv("NOVA_MODE", mode);
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_PUBLIC_URL", mode === "demo" ? "http://127.0.0.1:3100" : "https://nova.example.invalid");
  vi.stubEnv("NOVA_REPORT_DIR", "work/test-private");
  vi.stubEnv("NOVA_REPORT_KEY", "0".repeat(64));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
  vi.clearAllMocks();
  vi.mocked(transaction).mockImplementation((async (fn: (client: unknown) => Promise<unknown>) => fn({ query: sql })) as never);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("public triad family and join routes", () => {
  it("creates a family and joins a member in demo mode", async () => {
    stub("demo");
    await expect(startParentCase(parent, "zh-CN")).resolves.toHaveProperty("familyId");
    await expect(joinWithCode(joining, "zh-CN")).resolves.toHaveProperty("userId");
    expect(transaction).toHaveBeenCalled();
  });

  it("refuses family creation and join in service mode until the assigned scales are validated", async () => {
    stub("service");
    const refused = { status: 409, code: "TRIAD_UNVALIDATED" };
    await expect(startParentCase(parent, "zh-CN")).rejects.toMatchObject(refused);
    await expect(joinWithCode({ ...joining, role: "teacher" }, "zh-CN")).rejects.toMatchObject(refused);
    await expect(joinFamily(actor, { code: joining.code }, "zh-CN")).rejects.toMatchObject(refused);
    await expect(createParentFamily(parentActor, familyInput, "zh-CN")).rejects.toMatchObject(refused);
    await expect(joinClerkStudent(principal, { code: joining.code, name: "Synthetic student", role: "student" }, "zh-CN")).rejects.toMatchObject(refused);
    expect(transaction).not.toHaveBeenCalled();
    expect(limitLogin).not.toHaveBeenCalled();
  });
});
