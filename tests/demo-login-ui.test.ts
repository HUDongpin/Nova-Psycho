import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Login } from "../src/components/login";
import type { Session } from "../src/components/api";

const ids = {
  admin: "11111111-1111-4111-8111-111111111111",
  otherAdmin: "11111111-1111-4111-8111-111111111112",
  he: "22222222-2222-4222-8222-222222222221",
  chen: "22222222-2222-4222-8222-222222222222",
  zhouParent: "33333333-3333-4333-8333-333333333331",
  linParent: "33333333-3333-4333-8333-333333333333",
  zhouStudent: "44444444-4444-4444-8444-444444444441",
  linStudent: "44444444-4444-4444-8444-444444444444",
  teacher: "55555555-5555-4555-8555-555555555555",
};

const cnAccounts: Session["demoAccounts"] = [
  { id: ids.admin, name: "Nova 管理员 · 演示", role: "admin" },
  { id: ids.otherAdmin, name: "另一位管理员 · 演示", role: "admin" },
  { id: ids.he, name: "何老师 · 演示", role: "staff" },
  { id: ids.chen, name: "陈老师 · 演示", role: "staff" },
  { id: ids.zhouParent, name: "周家长 · 演示", role: "parent" },
  { id: ids.linParent, name: "林家长 · 演示", role: "parent" },
  { id: ids.zhouStudent, name: "周予安 · 演示", role: "student" },
  { id: ids.linStudent, name: "林小禾 · 演示", role: "student" },
  { id: ids.teacher, name: "许老师 · 演示", role: "teacher" },
];
const hkAccounts: Session["demoAccounts"] = [
  { id: ids.admin, name: "Nova 管理員 · 示範", role: "admin" },
  { id: ids.he, name: "何老師 · 示範", role: "staff" },
  { id: ids.chen, name: "陳老師 · 示範", role: "staff" },
  { id: ids.zhouParent, name: "周家長 · 示範", role: "parent" },
  { id: ids.linParent, name: "林家長 · 示範", role: "parent" },
  { id: ids.zhouStudent, name: "周予安 · 示範", role: "student" },
  { id: ids.linStudent, name: "林小禾 · 示範", role: "student" },
  { id: ids.teacher, name: "許老師 · 示範", role: "teacher" },
];

function session(over: Partial<Session> = {}): Session {
  return { user: null, region: "CN", mode: "demo", demoAccounts: cnAccounts, siblingUrl: null, authProvider: "local", identityState: "signed_out", ...over };
}
function render(value: Session, locale: "zh-CN" | "zh-HK" = "zh-CN") {
  return renderToStaticMarkup(createElement(Login, { session: value, locale, setLocale() {}, async onLogin() {} }));
}

describe("demo login buttons", () => {
  it("offers the seeded administrator, 林 case worker, 林 parent, 林 student, and teacher", () => {
    const html = render(session());
    const shown = ["Nova 管理员 · 演示", "陈老师 · 演示", "林家长 · 演示", "林小禾 · 演示", "许老师 · 演示"];
    const positions = shown.map(name => html.indexOf(name));
    expect(positions.every(index => index >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(html.match(/class="demo-account"/g)).toHaveLength(5);
    expect(html).toContain("管理员");
    expect(html).toContain("工作人员");
    expect(html).toContain("家长");
    expect(html).toContain("学生");
    expect(html).toContain("教师");
    expect(html).not.toContain("另一位管理员");
    expect(html).not.toContain("何老师");
    expect(html).not.toContain("周家长");
    expect(html).not.toContain("周予安");
    expect(html).toContain('name="password"');
  });

  it("uses the traditional 林 family doors in zh-HK", () => {
    const html = render(session({ region: "HK", demoAccounts: hkAccounts }), "zh-HK");
    for (const name of ["Nova 管理員 · 示範", "陳老師 · 示範", "林家長 · 示範", "林小禾 · 示範", "許老師 · 示範"]) expect(html).toContain(name);
    expect(html).toContain("管理員");
    expect(html).toContain("工作人員");
    expect(html).toContain("選擇一個示範帳戶");
    expect(html).not.toContain("何老師");
    expect(html).not.toContain("周家長");
    expect(html.match(/class="demo-account"/g)).toHaveLength(5);
  });

  it("still offers the only staff member when the showcase name is absent", () => {
    const html = render(session({ demoAccounts: [{ id: ids.he, name: "何老师 · 演示", role: "staff" }] }));
    expect(html).toContain("何老师 · 演示");
    expect(html.match(/class="demo-account"/g)).toHaveLength(1);
  });

  it("renders no demo buttons in service mode, even if demo accounts were supplied", () => {
    const html = render(session({ mode: "service" }));
    expect(html).not.toContain("demo-account");
    expect(html).not.toContain("选择一个演示账户");
    expect(html).not.toContain("林小禾");
    expect(html).not.toContain("Nova 管理员");
    expect(html).toContain('name="password"');
  });

  it("does not render demo buttons for Clerk, and leaves email entry in place", () => {
    const html = render(session({ authProvider: "clerk" }));
    expect(html).not.toContain("demo-account");
    expect(html).not.toContain("林小禾");
    expect(html).toContain('href="/sign-in"');
    expect(html).toContain('href="/sign-up"');
    expect(html).not.toContain('name="password"');
  });

  it("keeps designated test-account login and still hides demo buttons in service mode", () => {
    const html = render(session({ mode: "service", authProvider: "clerk", testAccountLoginEnabled: true, demoAccounts: cnAccounts }));
    expect(html).not.toContain("demo-account");
    expect(html).not.toContain("林小禾");
    expect(html).toContain('name="username"');
    expect(html).toContain('type="password"');
    expect(html).toContain('href="/sign-in"');
    expect(html).toContain("测试账号登录");
  });
});
