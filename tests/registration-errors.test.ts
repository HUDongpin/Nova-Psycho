import { describe, expect, it } from "vitest";
import { z } from "zod";
import { handle, HttpError } from "../src/lib/http";

describe("registration error responses", () => {
  it("identifies the family code field without returning the submitted code", async () => {
    const response = await handle(async () => { throw new HttpError(422, "请输入完整家庭编号。", "INVALID_JOIN_CODE_FORMAT", "code"); });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "请输入完整家庭编号。", code: "INVALID_JOIN_CODE_FORMAT", field: "code" });
  });

  it("returns a password requirement without echoing the password", async () => {
    const response = await handle(async () => {
      z.object({ password: z.string().min(12) }).parse({ password: "private" });
      return new Response();
    });
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.field).toBe("password");
    expect(body.error).toContain("12");
    expect(JSON.stringify(body)).not.toContain("private");
  });

  it("does not expose arbitrary schema paths or inputs", async () => {
    const response = await handle(async () => {
      z.record(z.string(), z.number()).parse({ private_identifier: "private_answer" });
      return new Response();
    });
    const body = await response.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body).not.toHaveProperty("field");
    expect(JSON.stringify(body)).not.toMatch(/private_identifier|private_answer/);
  });

  it("turns the username unique violation into a useful account action", async () => {
    const response = await handle(async () => { throw Object.assign(new Error("private SQL detail"), { code: "23505", constraint: "users_username_key" }); });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ code: "USERNAME_TAKEN", field: "username" });
    expect(body.error).toContain("登录后加入家庭");
    expect(JSON.stringify(body)).not.toContain("SQL");
  });
});
