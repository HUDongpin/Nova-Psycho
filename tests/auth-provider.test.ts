import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthProvider, getClerkConfig } from "../src/lib/auth-provider";

const publicKey = (host: string) => `pk_test_${Buffer.from(`${host}$`).toString("base64")}`;

beforeEach(() => {
  vi.stubEnv("NOVA_AUTH_PROVIDER", undefined);
  vi.stubEnv("NOVA_REGION", "CN");
  vi.stubEnv("NOVA_MODE", "demo");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/nova");
  vi.stubEnv("NOVA_PUBLIC_URL", "http://127.0.0.1:3100");
  vi.stubEnv("NOVA_REPORT_DIR", "work/test-private");
  vi.stubEnv("NOVA_REPORT_KEY", "0".repeat(64));
  vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", publicKey("synthetic.clerk.accounts.dev"));
  vi.stubEnv("CLERK_SECRET_KEY", "sk_test_synthetic_not_a_real_key");
  vi.stubEnv("NOVA_CLERK_ISSUER", undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("authentication provider configuration", () => {
  it("defaults to local and rejects unknown or empty modes", () => {
    expect(getAuthProvider()).toBe("local");
    vi.stubEnv("NOVA_AUTH_PROVIDER", "clerk");
    expect(getAuthProvider()).toBe("clerk");
    for (const value of ["", "Clerk", "unknown"]) {
      vi.stubEnv("NOVA_AUTH_PROVIDER", value);
      expect(() => getAuthProvider()).toThrow("NOVA_AUTH_PROVIDER");
    }
  });
  it("pins issuer to the trusted publishable key and parties to this deployment", () => {
    expect(getClerkConfig()).toMatchObject({
      issuer: "https://synthetic.clerk.accounts.dev",
      authorizedParties: ["http://127.0.0.1:3100"],
    });
  });
  it("refuses a configured issuer that belongs to another instance", () => {
    vi.stubEnv("NOVA_CLERK_ISSUER", "https://other.clerk.accounts.dev");
    expect(() => getClerkConfig()).toThrow("must match");
  });
  it("refuses mixed development and production keys without disclosing their values", () => {
    vi.stubEnv("CLERK_SECRET_KEY", "sk_live_synthetic_not_a_real_key");
    expect(() => getClerkConfig()).toThrow("Matching Clerk");
    try { getClerkConfig(); } catch (error) { expect(String(error)).not.toContain("synthetic_not_a_real_key"); }
  });
  it.each(["other.invalid/path", "other.invalid@evil.invalid", "localhost:8080", "other.invalid?x=1", "-bad.invalid"])("refuses an invalid decoded host %s", host => {
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", publicKey(host));
    expect(() => getClerkConfig()).toThrow("invalid hostname");
  });
});
