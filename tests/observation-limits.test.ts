import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../src/domain/types";
import type { Family } from "../src/components/api";

vi.mock("../src/lib/access", () => ({ familyFor: vi.fn(async () => ({})) }));
vi.mock("../src/lib/auth", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("../src/lib/db", () => ({ query: vi.fn(async () => []) }));

import { ObservationForm } from "../src/components/forms";
import { addObservation } from "../src/lib/care";
import { familyFor } from "../src/lib/access";
import { query } from "../src/lib/db";

const family: Family = {
  id: "22222222-3333-4444-8555-666666666666", familyName: "Synthetic family", childName: "Synthetic child",
  age: 12, birthDate: "2014-01-01", grade: "Synthetic", region: "CN", guardianLabel: "Synthetic guardian",
  assignedTo: null, canInviteMembers: false, createdAt: "2026-01-01T00:00:00Z", consent: true, members: [],
};
const actor: Actor = { id: "99999999-8888-4777-8666-555555555555", name: "Synthetic staff", role: "staff", region: "CN" };

beforeEach(() => vi.clearAllMocks());

describe("observation length contract", () => {
  it.each(["zh-CN", "zh-HK"] as const)("limits the %s input to the same 4000 characters the server accepts", locale => {
    const markup = renderToStaticMarkup(createElement(ObservationForm, {
      family, locale, onClose: () => undefined, onDone: async () => undefined,
    }));
    expect(markup.match(/<textarea[^>]*maxlength="(\d+)"/i)?.[1]).toBe("4000");
  });

  it("saves all 4000 characters at the accepted boundary", async () => {
    const body = "观".repeat(4000);
    await expect(addObservation(actor, { familyId: family.id, body })).resolves.toMatchObject({ id: expect.any(String) });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO observations"), [expect.any(String), family.id, body, actor.id]);
  });

  it("rejects 4001 characters before reading or writing family data", async () => {
    await expect(addObservation(actor, { familyId: family.id, body: "观".repeat(4001) })).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "too_big", maximum: 4000, path: ["body"] })],
    });
    expect(familyFor).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
