import { describe, expect, it } from "vitest";
import { grantedScopes, hasGranted, recordedScopes, scopeList } from "../src/lib/consent";

describe("consent scope records", () => {
  it("reads each purpose from its own row", () => {
    const rows = [{ scopes: ["assessment"] }, { scopes: ["sensitive_data"] }, { scopes: ["parent_report"] }];
    expect([...grantedScopes(rows)].sort()).toEqual(["assessment", "parent_report", "sensitive_data"]);
    expect(hasGranted(rows, ["assessment", "sensitive_data"])).toBe(true);
    expect(hasGranted(rows, ["parent_report"])).toBe(true);
  });

  it("keeps a legacy combined row as a grant for every listed purpose", () => {
    const rows = [{ scopes: ["assessment", "parent_report", "sensitive_data", "ai_processing"] }];
    expect(hasGranted(rows, ["assessment", "sensitive_data"])).toBe(true);
    expect(hasGranted(rows, ["parent_report"])).toBe(true);
    expect(grantedScopes(rows).has("ai_processing")).toBe(true);
  });

  it("does not treat a partial grant as the other purposes", () => {
    expect(hasGranted([{ scopes: ["assessment"] }], ["assessment", "sensitive_data"])).toBe(false);
    expect(hasGranted([{ scopes: ["parent_report"] }], ["assessment"])).toBe(false);
    expect(hasGranted([{ scopes: ["sensitive_data"] }], ["parent_report"])).toBe(false);
  });

  it("parses a stored json string and ignores empty or non-array values", () => {
    expect(scopeList("[\"assessment\"]")).toEqual(["assessment"]);
    expect(scopeList("not-json")).toEqual([]);
    expect(grantedScopes([{ scopes: { assessment: true } }, { scopes: [""] }, {}])).toEqual(new Set());
  });

  it("records only the purposes that were explicitly granted", () => {
    expect(recordedScopes({ assessment: true, sensitiveData: true, parentReport: false, aiProcessing: false })).toEqual(["assessment", "sensitive_data"]);
    expect(recordedScopes({ assessment: true, sensitiveData: true, parentReport: true, aiProcessing: true })).toEqual(["assessment", "sensitive_data", "parent_report", "ai_processing"]);
  });
});
