import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import config from "../next.config";

// Exercise the installed Next dev request-log filter against our next.config logging setting.
const { ignoreLoggingIncomingRequests } = createRequire(import.meta.url)("next/dist/server/dev/log-requests.js") as {
  ignoreLoggingIncomingRequests(request: { url: string }, logging: unknown): boolean;
};
const hidden = (url: string) => ignoreLoggingIncomingRequests({ url }, config.logging);

describe("dev incoming request logging", () => {
  it.each([
    "/recover", "/recover?token=SYNTHETIC_AUDIT5_RECOVERY_PAGE_MARKER", "/recover/", "/recover#token=x",
    "/invite", "/invite?token=SYNTHETIC_AUDIT5_INVITE_PAGE_MARKER", "/invite?_rsc=abc",
    "/api/recovery", "/api/recovery?token=SYNTHETIC_AUDIT5_RECOVERY_API_MARKER",
    "/api/invite", "/api/invite?token=SYNTHETIC_AUDIT5_INVITE_API_MARKER"
  ])("hides token-bearing entry point %s", url => { expect(hidden(url)).toBe(true); });

  it.each([
    "/", "/api/session", "/api/invites-history", "/api/inviter", "/api/recovery-status", "/recovery",
    "/recovered", "/invites", "/api/families/f1/invites", "/sign-in?redirect=/recover", "/x/recover?token=1"
  ])("keeps logging unrelated route %s", url => { expect(hidden(url)).toBe(false); });
});
