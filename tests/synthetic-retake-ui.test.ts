// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SyntheticRetakeEntry } from "../src/components/workspace-views";
import { copy } from "../src/components/copy";
import type { Family, Locale, Role } from "../src/components/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const family: Family = { id: "family", familyName: "Synthetic family", childName: "Synthetic child", age: 13, birthDate: "2013-01-01", grade: "S2", region: "HK", guardianLabel: "Synthetic", assignedTo: null, canInviteMembers: false, createdAt: "2026-01-01", consent: true, members: [], syntheticRetake: { previousRoundId: "previous" } };
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; vi.unstubAllGlobals(); document.body.replaceChildren(); });
async function render(locale: Locale, role: Role = "parent", target = family) {
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  const onRefresh = vi.fn(async () => undefined), navigate = vi.fn();
  await act(async () => root!.render(createElement(SyntheticRetakeEntry, { family: target, role, locale, onRefresh, navigate })));
  return { host, onRefresh, navigate };
}
for (const locale of ["zh-CN", "zh-HK"] as const) describe(`synthetic retake ${locale}`, () => {
  it("submits the server-pinned previous round once and refreshes before navigation", async () => {
    let resolve!: (value: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    const fetch = vi.fn(() => pending); vi.stubGlobal("fetch", fetch);
    const { host, onRefresh, navigate } = await render(locale);
    expect(host.textContent).toContain(copy(locale)("syntheticRetakeNote"));
    const button = host.querySelector("button")!;
    await act(async () => { button.click(); button.click(); });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/families/family/synthetic-retake?locale=${locale}`);
    expect(JSON.parse(options.body as string)).toEqual({ previousRoundId: "previous", locale });
    expect(button.disabled).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => { resolve(new Response(JSON.stringify({ roundId: "next", reused: false }), { status: 201 })); });
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith({ page: "assessments" });
    expect(onRefresh.mock.invocationCallOrder[0]).toBeLessThan(navigate.mock.invocationCallOrder[0]);
  });
  it("shows a server rejection without navigating or retrying automatically", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: "Scope revoked", code: "SYNTHETIC_RETAKE_DENIED" }), { status: 403 })); vi.stubGlobal("fetch", fetch);
    const { host, onRefresh, navigate } = await render(locale);
    await act(async () => host.querySelector("button")!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Scope revoked");
    expect(navigate).not.toHaveBeenCalled(); expect(onRefresh).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce(); expect(host.querySelector("button")!.disabled).toBe(false);
  });
  it.each(["student", "teacher", "admin", "staff"] as const)("does not render the entry for %s", async role => {
    const { host } = await render(locale, role); expect(host.textContent).toBe(""); expect(host.querySelector("button")).toBeNull();
  });
  it("does not render without server capability", async () => {
    const { host } = await render(locale, "parent", { ...family, syntheticRetake: undefined }); expect(host.textContent).toBe("");
  });
});
