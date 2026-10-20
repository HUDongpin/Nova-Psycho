import type { AiSettings, NarrativeSelection } from "./narrative";
import { requestAdviceOrdering } from "./narrative";
import type { AdviceLibrary, ContentSnapshot, Region, RespondentRole, ScaleDimension, ScoreResult, TriadDomainKey } from "./types";
import { TRIAD_DOMAIN_KEYS } from "./types";

export interface TriadNarrativeSource {
  role: RespondentRole;
  age: number;
  region: Region;
  status: ScoreResult["status"];
  risk: boolean;
  aiConsented: boolean;
  dimensions: { key: string; domain: TriadDomainKey; raw: number | null; higherMeans: ScaleDimension["higherMeans"] }[];
}
export interface TriadNarrativePolicy { triadEnabled: boolean; currentAiConsented: boolean }

const roleOrder: RespondentRole[] = ["student", "parent", "teacher"];
const domains = new Set<string>(TRIAD_DOMAIN_KEYS);
const knownDomain = (domain: string | undefined): domain is TriadDomainKey => domain !== undefined && domains.has(domain);
const usable = (raw: number | null): raw is number => typeof raw === "number" && Number.isFinite(raw);

// Never pass a snapshot or a TriadReport into the model adapter. Reconstruct this
// small DTO so identity, item answers, writing and risk messages cannot follow it.
export function buildTriadNarrativeSource(
  role: RespondentRole,
  scaleDimensions: readonly Pick<ScaleDimension, "key" | "domain">[],
  score: Pick<ScoreResult, "age" | "region" | "status" | "risk" | "dimensions">,
  aiConsented: boolean
): TriadNarrativeSource {
  return {
    role, age: score.age, region: score.region, status: score.status, risk: score.risk, aiConsented,
    dimensions: scaleDimensions.flatMap(dimension => {
      if (!knownDomain(dimension.domain)) return [];
      const scored = score.dimensions.find(item => item.key === dimension.key);
      if (!scored) return [];
      // A one-item result would reveal an individual answer, not an aggregate.
      const raw = scored.answered >= 2 && scored.totalItems >= 2 && usable(scored.raw) ? scored.raw : null;
      return [{ key: dimension.key, domain: dimension.domain, raw, higherMeans: scored.higherMeans }];
    })
  };
}

export function eligibleTriadAdviceIds(sources: readonly TriadNarrativeSource[], advice: ContentSnapshot<AdviceLibrary>): string[] {
  return [...new Set(advice.content.blocks.filter(block => {
    const applicability = block.triadApplicability;
    return applicability && sources.some(source =>
      applicability.roles.includes(source.role) && source.dimensions.some(dimension =>
        knownDomain(dimension.domain) && applicability.domainKeys.includes(dimension.domain) && usable(dimension.raw)));
  }).map(block => block.id))];
}

export function triadModelInput(sources: readonly TriadNarrativeSource[], advice: ContentSnapshot<AdviceLibrary>): Record<string, unknown> {
  const allowed = new Set(eligibleTriadAdviceIds(sources, advice));
  const blocks = advice.content.blocks.filter(block => allowed.has(block.id));
  return {
    sources: [...sources].sort((left, right) => roleOrder.indexOf(left.role) - roleOrder.indexOf(right.role)).map(source => ({
      role: source.role,
      ageBand: source.age < 10 ? "6-9" : source.age < 13 ? "10-12" : source.age < 16 ? "13-15" : "16-18",
      dimensions: source.dimensions.filter(dimension =>
        usable(dimension.raw) && blocks.some(block =>
          block.triadApplicability!.roles.includes(source.role) && block.triadApplicability!.domainKeys.includes(dimension.domain))
      ).map(dimension => ({ key: dimension.key, domain: dimension.domain, raw: dimension.raw, higherMeans: dimension.higherMeans }))
    })),
    advice: blocks.map(block => ({
      id: block.id,
      title: { "zh-CN": block.title["zh-CN"], "zh-HK": block.title["zh-HK"] },
      body: { "zh-CN": block.body["zh-CN"], "zh-HK": block.body["zh-HK"] }
    })),
    outputContract: {
      adviceIds: "An ordered list containing every eligible advice ID exactly once. No prose, scores or other fields. These are separate observations, not comparable scores. Do not infer severity, agreement, disagreement, a combined score, causes or diagnoses."
    }
  };
}

export function triadTemplateSelection(sources: readonly TriadNarrativeSource[], advice: ContentSnapshot<AdviceLibrary>, reason: string): NarrativeSelection {
  return { selectedAdviceIds: eligibleTriadAdviceIds(sources, advice), generationMode: "template", fallbackReason: reason, aiModel: null };
}

export async function selectTriadNarrative(
  sources: readonly TriadNarrativeSource[], advice: ContentSnapshot<AdviceLibrary>, settings: AiSettings,
  policy: TriadNarrativePolicy, fetcher: typeof fetch = fetch
): Promise<NarrativeSelection> {
  const fallback = (reason: string) => triadTemplateSelection(sources, advice, reason);
  if (sources.length !== 3 || !roleOrder.every(role => sources.filter(source => source.role === role).length === 1)) return fallback("invalid_triad_sources");
  if (sources.some(source => source.risk)) return fallback("risk_template");
  if (sources.some(source => source.status !== "valid")) return fallback("incomplete_template");
  if (!policy.currentAiConsented || sources.some(source => !source.aiConsented)) return fallback("no_ai_consent");
  if (!policy.triadEnabled) return fallback("triad_ai_disabled");
  if (!settings.enabled) return fallback("ai_disabled");
  if (sources.some(source => source.region !== settings.scope)) return fallback("region_mismatch");
  const ids = eligibleTriadAdviceIds(sources, advice);
  if (!ids.length) return fallback("no_advice_candidates");
  if (ids.length < 2) return fallback("insufficient_advice_candidates");
  return requestAdviceOrdering(ids, triadModelInput(sources, advice), settings, fetcher);
}
