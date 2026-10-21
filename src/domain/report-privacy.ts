import type { ReportPayload, ScaleDefinition, ScaleItem, TextPair } from "./types";

export const PARENT_REPORT_AUDIENCE_VERSION = 1;
export const reportPrivacyNotice: TextPair = {
  "zh-CN": "这份历史报告需要更新隐私保护，暂不能查看或下载。原始作答和评分已保留，请联系服务人员。",
  "zh-HK": "這份歷史報告需要更新私隱保護，暫不能查看或下載。原始作答和評分已保留，請聯絡服務人員。"
};
const parentTeamItems = new Set(["q32", "q33", "q34", "q35", "q36", "q37", "q38"]);

export function parentReportWordAllowed(scale: Pick<ScaleDefinition, "id" | "bundle">, item: Pick<ScaleItem, "id" | "report">): boolean {
  if (item.report !== "words") return false;
  if (scale.bundle !== "growth-triad") return true;
  return !(scale.id === "growth-parent" && parentTeamItems.has(item.id)) && !(scale.id === "growth-teacher" && item.id === "t23");
}

export function reportNeedsPrivacyRefresh(payload: ReportPayload): boolean {
  return isTriadReport(payload) && payload.triad?.parentAudienceVersion !== PARENT_REPORT_AUDIENCE_VERSION;
}

export function isTriadReport(payload: ReportPayload): boolean {
  return payload.scale?.bundle === "growth-triad" || Boolean(payload.triad);
}
