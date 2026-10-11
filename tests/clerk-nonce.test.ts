import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(async () => new Headers({ "x-nonce": "synthetic-request-nonce" })),
  provider: vi.fn(() => "clerk"),
  clerkProps: vi.fn(),
}));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("../src/lib/auth-provider", () => ({
  getAuthProvider: mocks.provider,
  getClerkConfig: () => ({ publishableKey: "pk_test_synthetic" }),
}));
vi.mock("@clerk/nextjs", () => ({
  ClerkProvider: (props: { children: ReactNode; nonce?: string; publishableKey?: string }) => {
    mocks.clerkProps({ nonce: props.nonce, publishableKey: props.publishableKey });
    return props.children;
  },
  useAuth: () => ({ isLoaded: true, sessionId: null }),
  useClerk: () => ({ signOut: async () => undefined, openUserProfile: () => undefined }),
}));

import RootLayout from "../src/app/layout";

beforeEach(() => {
  mocks.provider.mockReturnValue("clerk");
  mocks.clerkProps.mockClear();
  vi.stubEnv("NOVA_REGION", "HK");
});
afterEach(() => vi.unstubAllEnvs());

describe("Clerk script nonce", () => {
  it("passes the server request nonce through the client localization wrapper", async () => {
    const element = await RootLayout({ children: createElement("main", null, "Synthetic page") });
    const html = renderToStaticMarkup(element);
    expect(html).toContain('lang="zh-HK"');
    expect(mocks.clerkProps).toHaveBeenCalledWith(expect.objectContaining({ nonce: "synthetic-request-nonce", publishableKey: "pk_test_synthetic" }));
  });

  it("does not add the identity provider for local authentication", async () => {
    mocks.provider.mockReturnValue("local");
    const element = await RootLayout({ children: createElement("main", null, "Synthetic page") });
    expect(renderToStaticMarkup(element)).toContain("Synthetic page");
    expect(mocks.clerkProps).not.toHaveBeenCalled();
  });
});
