import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "next/dist/server/node-environment";
import { NextRequest, NextResponse, type NextFetchEvent } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";

const mocks = vi.hoisted(() => ({
  provider: vi.fn(() => "local"),
  config: vi.fn(() => ({
    publishableKey: "pk_test_synthetic",
    issuer: "https://synthetic.clerk.accounts.dev",
    authorizedParties: ["https://nova.synthetic.invalid"],
  })),
  clerkCalls: vi.fn(),
  redirect: false,
  options: undefined as unknown,
}));

vi.mock("../src/lib/auth-provider", () => ({ getAuthProvider: mocks.provider, getClerkConfig: mocks.config }));
vi.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware: (
    handler: (auth: unknown, request: NextRequest, event: NextFetchEvent) => NextResponse | void | Promise<NextResponse | void>,
    options: () => unknown,
  ) => async (request: NextRequest, event: NextFetchEvent) => {
    mocks.clerkCalls(request.nextUrl.pathname);
    mocks.options = options();
    if (mocks.redirect) {
      const response = NextResponse.redirect(new URL("/sign-in?handshake=synthetic", request.url));
      response.cookies.set("synthetic_handshake", "present", { httpOnly: true });
      return response;
    }
    const response = await handler({}, request, event) ?? NextResponse.next();
    response.headers.set("x-clerk-auth-status", "signed-in");
    response.cookies.set("synthetic_session", "present", { httpOnly: true });
    return response;
  },
}));

import proxy, { config } from "../src/proxy";

const event = {} as NextFetchEvent;
const request = (path = "/", headers?: HeadersInit) => new NextRequest(`https://nova.synthetic.invalid${path}`, { headers });
async function respond(request: NextRequest): Promise<Response> {
  const response = await proxy(request, event);
  if (!(response instanceof Response)) throw new Error("Proxy did not return a response");
  return response;
}
function policy(response: Response): string {
  const value = response.headers.get("content-security-policy");
  expect(value).toBeTruthy();
  return value!;
}
function directive(value: string, name: string): string {
  return value.split(";").map(part => part.trim()).find(part => part.startsWith(`${name} `)) ?? "";
}

beforeEach(() => {
  mocks.provider.mockReturnValue("local");
  mocks.clerkCalls.mockClear();
  mocks.config.mockClear();
  mocks.redirect = false;
  mocks.options = undefined;
  vi.stubEnv("NODE_ENV", "production");
});
afterEach(() => vi.unstubAllEnvs());

describe("application page CSP", () => {
  it.each(["/sign-in/factor.js", "/sign-up/factor.css"])("covers the actual catch-all page %s despite its extension", path => {
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: path })).toBe(true);
  });

  it("leaves static assets outside the page proxy", () => {
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: "/_next/static/chunk.js" })).toBe(false);
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: "/asset.svg" })).toBe(false);
  });

  it.each(["/", "/recover", "/invite", "/sign-in", "/sign-up"])("protects %s with a production script nonce", async path => {
    const response = await respond(request(path));
    const value = policy(response);
    expect(directive(value, "script-src")).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    expect(directive(value, "script-src")).toContain("'strict-dynamic'");
    expect(directive(value, "script-src")).not.toMatch(/unsafe-inline|unsafe-eval|https:\s|http:\s/);
    expect(directive(value, "script-src-attr")).toBe("script-src-attr 'none'");
    expect(directive(value, "style-src")).toBe("style-src 'self' 'unsafe-inline'");
    expect(directive(value, "object-src")).toBe("object-src 'none'");
    expect(directive(value, "base-uri")).toBe("base-uri 'self'");
    expect(directive(value, "frame-src")).toBe("frame-src 'self'");
    expect(value).not.toContain("clerk");
    expect(mocks.clerkCalls).not.toHaveBeenCalled();
  });

  it("overwrites an input nonce and forwards the matching CSP without losing request headers", async () => {
    const response = await respond(request("/", {
      "x-nonce": "attacker-controlled",
      "content-security-policy": "script-src 'unsafe-inline'",
      "x-synthetic-client": "kept",
    }));
    const value = policy(response);
    const nonce = value.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    expect(nonce).not.toBe("attacker-controlled");
    expect(response.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(value);
    expect(response.headers.get("x-middleware-request-x-synthetic-client")).toBe("kept");
    const second = await respond(request());
    expect(policy(second)).not.toBe(value);
  });

  it("allows eval only in development and retains the script nonce", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const value = policy(await respond(request()));
    expect(directive(value, "script-src")).toContain("'unsafe-eval'");
    expect(directive(value, "script-src")).toContain("'nonce-");
    expect(directive(value, "script-src")).not.toContain("'unsafe-inline'");
    expect(directive(value, "connect-src")).toContain("wss://nova.synthetic.invalid");
  });

  it.each(["/api/session", "/api/reports/synthetic/document", "/__clerk", "/__clerk/v1/client"])("does not replace the independent policy at %s", async path => {
    const response = await respond(request(path));
    expect(response.headers.has("content-security-policy")).toBe(false);
    expect(response.headers.has("x-middleware-request-x-nonce")).toBe(false);
  });
});

describe("Clerk middleware composition", () => {
  beforeEach(() => mocks.provider.mockReturnValue("clerk"));

  it("passes the CSP response through Clerk and preserves its auth headers and cookie", async () => {
    const response = await respond(request());
    const value = policy(response);
    expect(mocks.clerkCalls).toHaveBeenCalledWith("/");
    expect(mocks.options).toEqual({ publishableKey: "pk_test_synthetic", authorizedParties: ["https://nova.synthetic.invalid"] });
    expect(response.headers.get("x-clerk-auth-status")).toBe("signed-in");
    expect(response.headers.get("set-cookie")).toContain("synthetic_session=present");
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(value);
    expect(directive(value, "connect-src")).toContain("https://synthetic.clerk.accounts.dev");
    expect(directive(value, "frame-src")).toContain("https://challenges.cloudflare.com");
    expect(directive(value, "img-src")).toContain("https://img.clerk.com");
    expect(value).not.toMatch(/stripe|googleapis|https:\s|http:\s/);
    expect(directive(value, "script-src")).not.toMatch(/unsafe-inline|unsafe-eval/);
  });

  it("returns Clerk's early handshake redirect and cookie unchanged", async () => {
    mocks.redirect = true;
    const response = await respond(request("/recover"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://nova.synthetic.invalid/sign-in?handshake=synthetic");
    expect(response.headers.get("set-cookie")).toContain("synthetic_handshake=present");
  });

  it.each(["/api/liveness", "/api/queues/report", "/api/cron/reports"])("keeps %s outside Clerk", async path => {
    const response = await respond(request(path));
    expect(mocks.clerkCalls).not.toHaveBeenCalled();
    expect(response.headers.has("content-security-policy")).toBe(false);
  });

  it.each(["/api/reports/synthetic/document", "/api/session", "/__clerk/v1/client"])("still authenticates %s without adding the application policy", async path => {
    const response = await respond(request(path));
    expect(mocks.clerkCalls).toHaveBeenCalledWith(path);
    expect(response.headers.get("x-clerk-auth-status")).toBe("signed-in");
    expect(response.headers.has("content-security-policy")).toBe(false);
  });
});
