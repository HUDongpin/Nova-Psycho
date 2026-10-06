import { Converter } from "opencc-js";
import type { TextPair } from "./types";

const toHongKong = Converter({ from: "cn", to: "hk" });

export function pair(simplified: string): TextPair {
  return { "zh-CN": simplified, "zh-HK": toHongKong(simplified) };
}
