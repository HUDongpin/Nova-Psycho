import { z } from "zod";

export const registrationName = z.string().trim().min(1).max(100);
export const registrationUsername = z.string().trim().toLowerCase().regex(/^[a-z0-9_.@-]{3,100}$/);
export const registrationPassword = z.string().min(12).max(256);
export const joinCodeFormatMessage = "请输入家长提供的完整家庭编号，例如 TOPE-A2B3C4D5。";

export function parseJoinCode(value: string): string | null {
  if (value.trim().length > 32 || !/^[a-zA-Z0-9\s-]+$/.test(value)) return null;
  const compact = value.replace(/[\s-]/g, "").toUpperCase();
  const body = compact.startsWith("TOPE") && compact.length === 12 ? compact.slice(4) : compact;
  return /^[A-Z0-9]{8}$/.test(body) ? `TOPE-${body}` : null;
}

export function formatJoinCode(value: string): string {
  return parseJoinCode(value) ?? value.trim().toUpperCase();
}
