import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Family, Locale, Role, Workspace } from "../src/components/api";
import { copy } from "../src/components/copy";
import { FamilyView } from "../src/components/workspace-views";

function markup(role: Role, canInviteMembers: boolean, locale: Locale, consent = false) {
  const family: Family = { id: "synthetic-family", familyName: "Synthetic family", childName: "Synthetic child", age: 12, birthDate: "2014-01-01", grade: "Primary", region: "CN", guardianLabel: "Synthetic parent", assignedTo: canInviteMembers ? "synthetic-user" : "other-worker", createdAt: "2026-01-01T00:00:00Z", consent, members: [], canInviteMembers };
  const workspace: Workspace = { user: { id: "synthetic-user", name: "Synthetic user", role, region: "CN" }, region: "CN", mode: "demo", families: [family], assessments: [], reports: [], scales: [], goals: [], observations: [], staff: [], contentVersions: [], alerts: [], staffNotes: [], summary: {} };
  return renderToStaticMarkup(createElement(FamilyView, { family, workspace, locale, navigate: () => undefined, openForm: () => undefined, onRefresh: async () => undefined, openPrivacy: () => undefined }));
}

describe.each(["zh-CN", "zh-HK"] as const)("%s consent controls", locale => {
  it("hides consent mutation from staff with safety-only family visibility", () => {
    const html = markup("staff", false, locale);
    expect(html).not.toContain(copy(locale)("consentUpdate"));
    expect(html).toContain(copy(locale)("consentNotGranted"));
    expect(html).toContain(copy(locale)("addObservation"));
  });
  it.each(["staff", "admin"] as const)("shows consent mutation for a %s with the server family capability", role => {
    expect(markup(role, true, locale)).toContain(copy(locale)("consentUpdate"));
  });
  it("preserves online consent for the parent of a server-scoped family", () => {
    expect(markup("parent", false, locale)).toContain(copy(locale)("consentUpdate"));
  });
  it.each(["student", "teacher"] as const)("does not offer guardian consent to a %s", role => {
    expect(markup(role, false, locale)).not.toContain(copy(locale)("consentUpdate"));
  });
  it("preserves the completed-consent status", () => {
    const html = markup("parent", false, locale, true);
    expect(html).toContain(copy(locale)("consentGranted"));
    expect(html).toContain(copy(locale)("consentUpdate"));
  });
});
