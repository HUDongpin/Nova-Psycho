export type Region = "CN" | "HK";
export type Locale = "zh-CN" | "zh-HK";
export type Role = "admin" | "staff" | "parent" | "student" | "teacher";
export type RespondentRole = "parent" | "student" | "teacher";
export type TextPair = Record<Locale, string>;
export const text = (value: TextPair, locale: Locale) => value[locale];
export interface ScaleItem {
  id: string;
  label: TextPair;
  observerLabel?: TextPair;
  choices: { value: number; label: TextPair }[];
  reverse: boolean;
  required: boolean;
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
}
export interface Comparison {
  available: boolean;
  previousDate?: string;
  reason?: "first_assessment" | "incompatible_version" | "incomplete" | "different_respondent";
  changes?: { key: string; label: TextPair; delta: number; higherMeans: "more_support" | "more_strength" }[];
}
export interface Actor { id: string; name: string; role: Role; region: Region }
