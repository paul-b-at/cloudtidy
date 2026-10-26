import { routePatterns, type Config, type Route } from './config';
import { HelperError, run } from './process';

export const PROTOCOL_VERSION = 2;
export type Tier = 'rule' | 'model' | 'none';
export interface Decision {
 route: string | null;
 tier: Tier;
 needsReview: boolean;
 reason: string;
 /** Transient failures (timeout/unavailable/crash) are retried and cached only briefly. */
 transient: boolean;
 /** Unverified model suggestions; naming.ts validates them against the text before use. */
 documentDate: string | null;
 sender: string | null;
}
export const review = (reason: string, transient = false): Decision => ({ route: null, tier: 'none', needsReview: true, reason, transient, documentDate: null, sender: null });
const RESPONSE_KEYS = ['version', 'route', 'documentDate', 'sender', 'needsReview'];
export interface ModelResult { route: string; needsReview: boolean; documentDate: string | null; sender: string | null }
/** Strict shape check. Unknown keys (e.g. a smuggled `suggestedName`), wrong version, or non-string fields fail closed. */
export function parseModelResult(raw: unknown, config: Config): ModelResult | null {
 if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
 const r = raw as Record<string, unknown>;
 if (Object.keys(r).length !== RESPONSE_KEYS.length || !RESPONSE_KEYS.every(k => k in r)) return null;
 if (r.version !== PROTOCOL_VERSION || typeof r.needsReview !== 'boolean' || typeof r.route !== 'string' || typeof r.documentDate !== 'string' || typeof r.sender !== 'string') return null;
 if (r.documentDate.length > 32 || r.sender.length > 200) return null;
 if (r.route !== 'review' && !config.routes.some(x => x.id === r.route)) return null;
 return { route: r.route, needsReview: r.needsReview || r.route === 'review', documentDate: r.documentDate || null, sender: r.sender || null };
}
export function validateResult(raw: unknown, config: Config): Decision {
 const m = parseModelResult(raw, config);
 if (!m) return review('invalid_response');
 if (m.needsReview) return review('model_uncertain');
 return { route: m.route, tier: 'model', needsReview: false, reason: 'model_suggestion', transient: false, documentDate: m.documentDate, sender: m.sender };
}
/** Tier 1: the route whose Notion patterns match, only when exactly ONE route matches. Conflicts and no-match go to the model. */
export function heuristics(filename: string, text: string, config: Config): Route | null {
 const input = `${filename}\n${text.slice(0, 20000)}`;
 const hits = config.routes.filter(r => routePatterns(r).some(re => re.test(input)));
 return hits.length === 1 ? hits[0]! : null;
}
export type ModelCall = (filename: string, text: string, config: Config) => Promise<unknown>;
export const MODEL_TEXT_LIMIT = 2400;
/** First `limit` UTF-16 units without splitting a surrogate pair (a lone surrogate would break JSON/UTF-8 encoding of the request). */
export const safeSlice = (text: string, limit: number): string => {
 if (text.length <= limit) return text;
 const code = text.charCodeAt(limit - 1);
 return text.slice(0, code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit);
};
export const callHelper: ModelCall = async (filename, text, config) => {
 const input = { version: PROTOCOL_VERSION, filename, text: safeSlice(text, MODEL_TEXT_LIMIT), routes: config.routes.map(({ id, description }) => ({ id, description })) };
 return JSON.parse(await run(config.classifier, [], JSON.stringify(input), config.timeoutMs));
};
export interface ClassifyDeps { model?: ModelCall; sleep?: (ms: number) => Promise<unknown> }
async function askModel(filename: string, text: string, config: Config, deps: ClassifyDeps): Promise<Decision> {
 const call = deps.model ?? callHelper, sleep = deps.sleep ?? Bun.sleep;
 let last: Decision = review('model_failed', true);
 for (let attempt = 0; attempt <= config.classifierRetries; attempt++) {
  if (attempt > 0) await sleep(500 * attempt);
  try { return validateResult(await call(filename, text, config), config); }
  catch (e) {
   if (e instanceof SyntaxError) return review('invalid_response');
   const code = e instanceof HelperError ? e.message : 'helper_failed';
   last = review(code === 'helper_timeout' ? 'model_timeout' : code === 'helper_unavailable' || (e instanceof HelperError && e.exitCode === 2) ? 'model_unavailable' : 'model_failed', true);
  }
 }
 return last;
}
/** Does this route want a model-provided date/sender even when a rule already chose the route? */
export const wantsNaming = (route: Route, config: Config) => route.rename || (config.naming.datePrefix && route.folder === '04_Persönlich');
export async function classify(filename: string, text: string, config: Config, deps: ClassifyDeps = {}): Promise<Decision> {
 if (!text.trim()) return review('empty_text');
 const rule = heuristics(filename, text, config);
 if (!rule) return askModel(filename, text, config, deps);
 const base: Decision = { route: rule.id, tier: 'rule', needsReview: false, reason: 'rule_match', transient: false, documentDate: null, sender: null };
 if (!wantsNaming(rule, config)) return base;
 // The rule fixes the route. The model is consulted only for date/sender; its route may confirm (name data used) or contradict (review).
 const m = await askModel(filename, text, config, deps);
 if (m.needsReview || m.route === null) return { ...base, reason: m.transient ? 'rule_match_model_unavailable' : 'rule_match_model_uncertain', transient: m.transient };
 if (m.route !== rule.id) return review('rule_model_disagreement');
 return { ...base, documentDate: m.documentDate, sender: m.sender };
}
export interface ModelStatus { available: boolean; reason: string }
/** `classify --check`: availability only, no generation. Never throws. */
export async function checkModel(config: Config): Promise<ModelStatus> {
 try {
  const x: unknown = JSON.parse(await run(config.classifier, ['--check'], '', Math.min(config.timeoutMs, 15000)));
  if (x && typeof x === 'object' && (x as Record<string, unknown>).version === PROTOCOL_VERSION && typeof (x as Record<string, unknown>).available === 'boolean') {
   const r = x as { available: boolean; reason?: unknown };
   return { available: r.available, reason: typeof r.reason === 'string' ? r.reason.slice(0, 64) : r.available ? 'available' : 'unavailable' };
  }
  return { available: false, reason: 'unexpected_protocol_version' };
 } catch (e) { return { available: false, reason: e instanceof HelperError && e.message === 'helper_unavailable' ? 'helper_not_built' : 'check_failed' }; }
}
