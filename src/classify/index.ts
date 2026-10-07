import type { Config } from "../config";
import { type HeuristicInput, type Rule, scoreHeuristics } from "./heuristics";
import type { Tier2 } from "./llm";

export type Decision =
  | {
      kind: "sorted";
      tier: 1 | 2;
      category: string;
      sub: string | null;
      confidence: number;
      suggestedName: string | null;
      reason: string;
    }
  | { kind: "review"; tier: 1 | 2; reason: string };

export interface ClassifyContext {
  config: Config;
  rules: Rule[];
  tier2: Tier2 | null;
}

export async function classify(input: HeuristicInput, ctx: ClassifyContext): Promise<Decision> {
  const h = scoreHeuristics(input, ctx.rules, ctx.config.heuristics);
  if (h.definite && h.category) {
    const subfolders = ctx.config.buckets[h.category]?.subfolders ?? [];
    return {
      kind: "sorted",
      tier: 1,
      category: h.category,
      sub: h.sub && subfolders.includes(h.sub) ? h.sub : null,
      confidence: 1,
      suggestedName: null,
      reason: `rules ${h.matched.join(", ")} (score ${h.score} vs ${h.runnerUp})`,
    };
  }

  const tier1Note = h.category
    ? `rules unsure (${h.category} ${h.score} vs ${h.runnerUp})`
    : "no rule matched";
  if (!ctx.tier2) return { kind: "review", tier: 1, reason: `${tier1Note}; LLM disabled` };

  const outcome = await ctx.tier2.classify(input);
  if (!outcome.ok) return { kind: "review", tier: 2, reason: `${tier1Note}; ${outcome.reason}` };

  const { result } = outcome;
  const threshold = ctx.config.llm.confidenceThreshold;
  if (result.confidence < threshold) {
    return {
      kind: "review",
      tier: 2,
      reason: `LLM unsure: ${result.category} at ${result.confidence.toFixed(2)} < ${threshold}`,
    };
  }
  return {
    kind: "sorted",
    tier: 2,
    category: result.category,
    sub: result.sub,
    confidence: result.confidence,
    suggestedName: result.suggestedName || null,
    reason: `LLM ${result.confidence.toFixed(2)}`,
  };
}
