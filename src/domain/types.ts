export type Region = "CN" | "HK";
export type Locale = "zh-CN" | "zh-HK";
export type Role = "admin" | "staff" | "parent" | "student" | "teacher";
export type RespondentRole = "parent" | "student" | "teacher";
export type TextPair = Record<Locale, string>;
export const text = (value: TextPair, locale: Locale) => value[locale];
export type ItemKind = "single" | "multi" | "text";
export type ItemReport = "omit" | "words" | "situation" | "priorities" | "staff";
export type StoredAnswer = number | number[] | string;
export interface ScaleItem {
  id: string;
  label: TextPair;
  observerLabel?: TextPair;
  kind?: ItemKind;
  choices: { value: number; label: TextPair }[];
  reverse: boolean;
  required: boolean;
  excludeValues?: number[];
  maxChoices?: number;
  showIf?: { itemId: string; anyOf: number[] };
  page?: string;
  pageTitle?: TextPair;
  panel?: TextPair;
  shuffle?: boolean;
  gate?: number;
  report?: ItemReport;
}
export interface ScaleBand {
  minimum: number;
  key: string;
  label: TextPair;
  explanation: TextPair;
  adviceIds: string[];
}
export interface ScaleDimension {
  key: string;
  label: TextPair;
  items: string[];
  aggregation: "sum" | "mean";
  maxMissing: number;
  prorate: boolean;
  higherMeans: "more_support" | "more_strength";
  bands: ScaleBand[];
  optional?: boolean;
  domain?: string;
}
export interface ScaleDefinition {
  id: string;
  version: string;
  title: TextPair;
  description: TextPair;
  demo: boolean;
  source: string;
  rights: { digital: boolean; commercial: boolean; reference: string };
  minAge: number;
  maxAge: number;
  regions: Region[];
  roles: RespondentRole[];
  retakeDays: number;
  norm: { label: TextPair; source: string; regions: Region[]; minAge: number; maxAge: number; validated: boolean };
  items: ScaleItem[];
  dimensions: ScaleDimension[];
  riskRules: { itemId: string; values: number[]; message: TextPair }[];
  bundle?: string;
}
export interface TriadView {
  role: RespondentRole;
  label: TextPair;
  body: TextPair;
  raw: number | null;
}
export interface TriadReport {
  title: TextPair;
  sources: { role: RespondentRole; submittedAt: string }[];
  safety: TextPair[];
  domains: { key: string; label: TextPair; note: TextPair | null; views: TriadView[] }[];
  portrait: { heading: TextPair; body: TextPair }[];
  situations: { role: RespondentRole; prompt: TextPair; choice: TextPair }[];
  priorities: { role: RespondentRole; prompt: TextPair; choices: TextPair[] }[];
  words: { role: RespondentRole; prompt: TextPair; value: string }[];
}
export interface DimensionScore {
  key: string;
  label: TextPair;
  raw: number | null;
  min: number;
  max: number;
  answered: number;
  totalItems: number;
  missing: string[];
  prorated: boolean;
  band: ScaleBand | null;
  higherMeans: "more_support" | "more_strength";
}
export interface ScoreResult {
  status: "valid" | "incomplete" | "ineligible";
  reasons: string[];
  scaleId: string;
  scaleVersion: string;
  respondentRole: RespondentRole;
  region: Region;
  age: number;
  demo: boolean;
  norm: ScaleDefinition["norm"];
  dimensions: DimensionScore[];
  risk: boolean;
  riskMessages: TextPair[];
}
export interface AdviceBlock {
  id: string;
  title: TextPair;
  body: TextPair;
  source: string;
  dimensionKeys: string[];
}
export interface AdviceLibrary {
  title: TextPair;
  blocks: AdviceBlock[];
}
export interface ReportTemplate {
  title: TextPair;
  introduction: TextPair;
  limitation: TextPair;
  nextStep: TextPair;
}
export interface ContentSnapshot<T> { id: string; version: string; content: T }
export interface AssessmentSnapshot {
  scale: ScaleDefinition;
  advice: ContentSnapshot<AdviceLibrary>;
  template: ContentSnapshot<ReportTemplate>;
  score: ScoreResult;
  childName: string;
  grade: string;
  submittedAt: string;
  aiConsented: boolean;
}
export interface ReportPayload extends AssessmentSnapshot {
  selectedAdviceIds: string[];
  generationMode: "template" | "ai";
  fallbackReason: string | null;
  aiModel: string | null;
  comparison: Comparison;
  triad?: TriadReport;
}
export interface Comparison {
  available: boolean;
  previousDate?: string;
  reason?: "first_assessment" | "incompatible_version" | "incomplete" | "different_respondent";
  changes?: { key: string; label: TextPair; delta: number; higherMeans: "more_support" | "more_strength" }[];
}
export interface Actor { id: string; name: string; role: Role; region: Region }
