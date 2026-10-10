import { Converter } from "opencc-js";
import type { Locale, TextPair } from "./types";

const toHongKong = Converter({ from: "cn", to: "hk" });

const toSimplified = Converter({ from: "hk", to: "cn" });

export function localizeText(text: string, locale: Locale): string {
  return locale === "zh-HK" ? toHongKong(text) : toSimplified(text);
}

export function pair(simplified: string): TextPair {
  return { "zh-CN": simplified, "zh-HK": toHongKong(simplified) };
}
