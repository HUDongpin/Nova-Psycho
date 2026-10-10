import type { ScaleDefinition } from "./types";

// The stated c_age answer is compared with the birth-date age. The result is a
// stable code only: callers must not log either age or the answer text.
export function statedAgeMismatch(scale: ScaleDefinition, answers: Record<string, unknown>, birthAge: number): boolean {
  if (!scale.items.some(item => item.id === "c_age")) return false;
  const stated = answers.c_age;
  return typeof stated === "number" && Number.isInteger(stated) && Number.isInteger(birthAge) && stated !== birthAge;
}
