import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../src/lib/auth", () => ({ audit: vi.fn(), hashPassword: vi.fn(async () => "synthetic-hash"), limitLogin: vi.fn(async () => undefined) }));
vi.mock("../src/lib/config", () => ({ getConfig: () => ({ region: "HK" }) }));
import { transaction } from "../src/lib/db";
import { hashPassword, limitLogin } from "../src/lib/auth";
import { startParentCase, joinWithCode } from "../src/lib/triad";
import { handle } from "../src/lib/http";
import { noticeVersion } from "../src/lib/privacy";

const parent = { parentName: "Synthetic parent", username: "synthetic.parent", password: "synthetic-password", relationship: "母亲", childName: "Synthetic child", birthDate: "2014-10-08", grade: "小学四至六年级", accepted: true };
const joining = { code: "TOPE-A2B3C4D5", role: "student", name: "Synthetic student", username: "synthetic.student", password: "synthetic-password" };
let birthDate = "2014-10-08", roleTaken = false, duplicate = false, missingFamily = false, hasConsent = true;
const sql = vi.fn(async (text: string, _values?: unknown[]) => {
  if (text.startsWith("INSERT INTO users") && duplicate) throw Object.assign(new Error("Synthetic duplicate"), { code: "23505" });
  if (text.startsWith("SELECT id FROM scales")) return { rows: [{ id: "synthetic-scale" }] };
  if (text.startsWith("SELECT id,birth_date FROM families")) return { rows: missingFamily ? [] : [{ id: "synthetic-family", birth_date: birthDate }] };
  if (text.startsWith("SELECT 1 FROM memberships")) return { rows: roleTaken ? [{}] : [] };
  if (text.startsWith("SELECT id FROM consents")) return { rows: hasConsent ? [{ id: "consent" }] : [] };
  return { rows: [] };
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
  vi.clearAllMocks(); birthDate = "2014-10-08"; roleTaken = duplicate = missingFamily = false; hasConsent = true;
  vi.mocked(transaction).mockImplementation((async (fn: (client: unknown) => Promise<unknown>) => fn({ query: sql })) as never);
});
afterEach(() => vi.useRealTimers());

describe("P23 age eligibility at the real service boundary with mocked SQL", () => {
  it.each([
    ["just under eight", "2018-10-09", false], ["exactly eight", "2018-10-08", true],
    ["just under eighteen", "2008-10-09", true], ["exactly eighteen", "2008-10-08", false],
    ["future", "2026-10-09", false],
  ] as const)("parent: %s", async (_name, date, accepted) => {
    const result = startParentCase({ ...parent, birthDate: date }, "zh-HK");
    if (accepted) await expect(result).resolves.toHaveProperty("familyId");
    else { await expect(result).rejects.toMatchObject({ status: 422, code: "CHILD_AGE" }); expect(transaction).not.toHaveBeenCalled(); }
  });
  it.each(["student", "teacher"] as const)("rechecks the family age when a %s joins", async role => {
    birthDate = "2008-10-08";
    await expect(joinWithCode({ ...joining, role }, "zh-HK")).rejects.toMatchObject({ code: "CHILD_AGE" });
    expect(sql.mock.calls.some(([text]) => text.startsWith("INSERT"))).toBe(false);
  });
  it.each(["2014-02-30", "2014-13-01", "2014-00-01"])("rejects invalid calendar date %s before writes", async date => {
    await expect(startParentCase({ ...parent, birthDate: date }, "zh-HK")).rejects.toMatchObject({ code: "INVALID_BIRTHDATE" });
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("P25/P26 account validation", () => {
  it("identifies a short family code before any account or database operation", async () => {
    await expect(joinWithCode({ ...joining, code: "TOPE-E1", role: "teacher" }, "zh-HK")).rejects.toMatchObject({ code: "INVALID_JOIN_CODE_FORMAT", status: 422, field: "code" });
    expect(transaction).not.toHaveBeenCalled(); expect(limitLogin).not.toHaveBeenCalled();
  });
  it.each(["ab", "a".repeat(101), "contains space", "中文用户", "bad/slash"])("rejects invalid username %s before writes", async username => {
    await expect(startParentCase({ ...parent, username }, "zh-HK")).rejects.toHaveProperty("name", "ZodError");
    expect(transaction).not.toHaveBeenCalled(); expect(limitLogin).not.toHaveBeenCalled();
  });
  it("normalizes supported uppercase/whitespace without altering display names", async () => {
    await startParentCase({ ...parent, username: " Test.User_1@site-hk " }, "zh-HK");
    const values = sql.mock.calls.find(([text]) => text.startsWith("INSERT INTO users"))![1]!;
    expect(values[2]).toBe("test.user_1@site-hk"); expect(values[3]).toBe(parent.parentName);
  });
  it.each([11, 12, 256, 257])("enforces password length %i for parent/student/teacher", async length => {
    for (const role of ["parent", "student", "teacher"] as const) {
      vi.clearAllMocks();
      const password = "x".repeat(length);
      const result = role === "parent" ? startParentCase({ ...parent, password }, "zh-HK") : joinWithCode({ ...joining, role, password }, "zh-HK");
      if (length === 12 || length === 256) { await expect(result).resolves.toHaveProperty("userId"); expect(hashPassword).toHaveBeenCalledWith(password); }
      else { await expect(result).rejects.toHaveProperty("name", "ZodError"); expect(transaction).not.toHaveBeenCalled(); }
    }
  });
  it("maps duplicate username failure to 409 and stops before creating a family", async () => {
    duplicate = true;
    const response = await handle(async () => Response.json(await startParentCase(parent, "zh-HK")));
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "USERNAME_TAKEN" });
    expect(sql.mock.calls.some(([text]) => text.startsWith("INSERT INTO families"))).toBe(false);
  });
});

describe("P27/P36/P42 correct family, role, locale and consent binding", () => {
  it.each([false, undefined])("requires explicit parent consent (%s)", async accepted => {
    await expect(startParentCase({ ...parent, accepted }, "zh-HK")).rejects.toHaveProperty("name", "ZodError");
    expect(transaction).not.toHaveBeenCalled();
  });
  it("binds parent, consent and assessment to the same new family within one transaction", async () => {
    const result = await startParentCase(parent, "zh-HK");
    expect(transaction).toHaveBeenCalledTimes(1);
    const values = (prefix: string) => sql.mock.calls.find(([text]) => text.startsWith(prefix))![1]!;
    expect(values("INSERT INTO families")[0]).toBe(result.familyId);
    expect(values("INSERT INTO memberships")).toEqual([result.familyId, result.userId]);
    expect(values("INSERT INTO consents").slice(1, 5)).toEqual([result.familyId, result.userId, parent.parentName, noticeVersion]);
    expect(JSON.parse(String(values("INSERT INTO consents")[5]))).toEqual(["assessment", "parent_report", "sensitive_data"]);
    expect(values("INSERT INTO assessments").slice(1, 6)).toEqual([result.familyId, "HK", result.userId, "growth-parent@1.0.0", "zh-HK"]);
  });
  it.each(["student", "teacher"] as const)("assigns the correct %s instrument under a regional family lock", async role => {
    const result = await joinWithCode({ ...joining, role }, "zh-HK");
    const family = sql.mock.calls.find(([text]) => text.startsWith("SELECT id,birth_date"))!;
    expect(family[0]).toContain("region=$2 FOR UPDATE"); expect(family[1]).toEqual([joining.code, "HK"]);
    const task = sql.mock.calls.find(([text]) => text.startsWith("INSERT INTO assessments"))![1]!;
    expect(task.slice(1, 7)).toEqual(["synthetic-family", "HK", result.userId, role, role === "student" ? "growth-child@1.0.0" : "growth-teacher@1.0.0", "zh-HK"]);
  });
  it("rejects reuse of an occupied role before creating another user or task", async () => {
    roleTaken = true;
    await expect(joinWithCode(joining, "zh-HK")).rejects.toMatchObject({ code: "ROLE_TAKEN", status: 409 });
    expect(sql.mock.calls.some(([text]) => text.startsWith("INSERT"))).toBe(false);
  });
  it("rejects a missing or cross-region join code before writing", async () => {
    missingFamily = true;
    await expect(joinWithCode(joining, "zh-HK")).rejects.toMatchObject({ code: "INVALID_JOIN_CODE", status: 404 });
    expect(sql.mock.calls.some(([text]) => text.startsWith("INSERT"))).toBe(false);
  });
  it("cannot bypass revoked consent through the legacy student registration payload", async () => {
    hasConsent = false;
    await expect(joinWithCode(joining, "zh-HK")).rejects.toMatchObject({ code: "GUARDIAN_CONSENT_REQUIRED" });
    expect(sql.mock.calls.some(([text]) => text.startsWith("INSERT"))).toBe(false);
  });
});
