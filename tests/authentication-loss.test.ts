import { describe, expect, it } from "vitest";
import { ApiError, isAuthenticationLost } from "../src/components/api";

describe("client authentication loss", () => {
  it.each([[401, "UNAUTHENTICATED"], [403, "ACCOUNT_REVOKED"]] as const)("suspends on %i %s", (status, code) => {
    expect(isAuthenticationLost(new ApiError("Synthetic failure", code, status))).toBe(true);
  });
  it.each([[403, "ROLE_DENIED"], [403, "EMAIL_NOT_VERIFIED"], [404, "NOT_FOUND"], [500, "ACCOUNT_REVOKED"]] as const)("preserves ordinary failure %i %s", (status, code) => {
    expect(isAuthenticationLost(new ApiError("Synthetic failure", code, status))).toBe(false);
  });
  it("does not classify network failures as lost authentication", () => {
    expect(isAuthenticationLost(new TypeError("Failed to fetch"))).toBe(false);
  });
});
