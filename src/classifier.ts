import { routeEvidence, routePatterns, type Config, type Route } from './config';
import { DATE_PREFIX_FOLDERS, extractNaming } from './naming';
import { HelperError, helperState, run } from './process';

export const PROTOCOL_VERSION = 2;
export type Tier = 'rule' | 'model' | 'none';
export interface Decision {
 route: string | null;
 tier: Tier;
 needsReview: boolean;
 reason: string;
 /** Transient failure (model unavailable/busy/timeout): the file stays in `_Inbox` as pending and is retried on a later run. */
 transient: boolean;
 /** Date/sender found deterministically in the text, or suggested by the model; naming.ts validates both against the text before use. */
 documentDate: string | null;
 sender: string | null;
 /** Timings for `eval`: deciding the route (rules, or model for rule-less files) vs. working out the name. */
 routeMs?: number;
 namingMs?: number;
 modelCalls?: number;
 /** Rule hit whose name could not be improved because the model gave a definite failure (refusal, guardrail, ...): route kept, original name, this reason is shown/logged. */
 namingReason?: string;
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
/**
 * Tier 1: the route whose patterns match as whole words, only when exactly ONE route matches. A single hit is final (no model check;
 * accepted risk: any text in the document, including hidden text, can steer a rule route). Conflicts and no match go to the model.
 */
const matchWindow = (filename: string, text: string) => `${filename}\n${text.slice(0, 20000)}`.normalize('NFC'); // patterns are written NFC; HFS-era names / some OCR output are NFD
/** A route without `evidence` is always verified; one with `evidence` needs at least one whole-word hit in the file name or the first 20k characters. Never used for Tier 1. */
export function routeVerified(route: Route, filename: string, text: string): boolean {
 const ev = routeEvidence(route);
 if (!ev.length) return true;
 const input = matchWindow(filename, text);
 return ev.some(re => re.test(input));
}
export function heuristics(filename: string, text: string, config: Config): Route | null {
 const input = matchWindow(filename, text);
 const hits = config.routes.filter(r => routePatterns(r).some(re => re.test(input)));
 return hits.length === 1 ? hits[0]! : null;
}
/** `lockedRoute`: the route is already decided by a rule; the model may only fill in date/sender. */
export type ModelCall = (filename: string, text: string, config: Config, lockedRoute?: string | null) => Promise<unknown>;
export const MODEL_TEXT_LIMIT = 2400;
/** First `limit` UTF-16 units without splitting a surrogate pair (a lone surrogate would break JSON/UTF-8 encoding of the request). */
export const safeSlice = (text: string, limit: number): string => {
 if (text.length <= limit) return text;
 const code = text.charCodeAt(limit - 1);
 return text.slice(0, code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit);
};
export const callHelper: ModelCall = async (filename, text, config, lockedRoute = null) => {
 const st = await helperState(config.classifier);
 if (st !== 'ok') throw new HelperError('helper_unavailable', null, null, false, `classifier_helper_missing:${st}`); // not built / not executable: reported as such, not as "model unavailable"
 const input = { version: PROTOCOL_VERSION, filename, text: safeSlice(text, MODEL_TEXT_LIMIT), routes: config.routes.map(({ id, description }) => ({ id, description })), ...(lockedRoute ? { lockedRoute } : {}) };
 return JSON.parse(await run(config.classifier, [], JSON.stringify(input), config.timeoutMs));
};
export interface ClassifyDeps { model?: ModelCall; sleep?: (ms: number) => Promise<unknown> }
export type ModelOutcome = { kind: 'ok'; result: ModelResult } | { kind: 'transient'; reason: string; retry: boolean } | { kind: 'failed'; reason: string };
/** The helper's own diagnostic token (stderr `classification_failed:<code>`) -> a specific, user-visible reason. Anything unknown stays `model_failed`. */
const TOKEN_REASON: Record<string, string> = {
 refusal: 'model_refusal', guardrail_violation: 'model_guardrail', unsupported_language: 'model_unsupported_language', context_window_exceeded: 'model_context_overflow',
 decoding_failure: 'model_invalid_output', invalid_request: 'model_invalid_request', oversized_request: 'model_invalid_request'
};
/**
 * Helper failure -> outcome. Transient (retry later, file stays in _Inbox): unavailable / modelNotReady (exit 2), rate limited or
 * concurrent requests (exit 4), timeout, crash by signal. Everything else (refusal, guardrail, unsupported language, context overflow,
 * invalid output, bad request) is a definite answer for this document. The specific reason is kept, never collapsed: review shows
 * `model_refusal`, `model_guardrail`, `model_unsupported_language`, `model_context_overflow`, `model_invalid_output`, ... .
 */
export function modelFailure(e: unknown): ModelOutcome {
 if (e instanceof SyntaxError) return { kind: 'failed', reason: 'invalid_response' };
 if (!(e instanceof HelperError)) return { kind: 'failed', reason: 'model_failed' };
 if (e.message === 'helper_timeout') return { kind: 'transient', reason: 'model_timeout', retry: true };
 if (e.message === 'helper_unavailable') return { kind: 'transient', reason: e.diag?.startsWith('classifier_helper_missing') ? (e.diag.endsWith(':missing') ? 'classifier_helper_missing' : e.diag) : 'model_unavailable', retry: false };
 if (e.exitCode === 2) return { kind: 'transient', reason: 'model_unavailable', retry: false };
 if (e.exitCode === 4) return { kind: 'transient', reason: 'model_busy', retry: true };
 if (e.message === 'helper_failed' && e.exitCode === null) return { kind: 'transient', reason: 'model_crashed', retry: true };
 return { kind: 'failed', reason: (e.token && Object.hasOwn(TOKEN_REASON, e.token) && TOKEN_REASON[e.token]) || 'model_failed' };
}
async function callModel(filename: string, text: string, config: Config, deps: ClassifyDeps, locked: string | null): Promise<ModelOutcome> {
 const call = deps.model ?? callHelper, sleep = deps.sleep ?? Bun.sleep;
 let last: ModelOutcome = { kind: 'failed', reason: 'model_failed' };
 for (let attempt = 0; attempt <= config.classifierRetries; attempt++) {
  if (attempt > 0) await sleep(500 * attempt);
  try {
   const m = parseModelResult(await call(filename, text, config, locked), config);
   if (!m) return { kind: 'failed', reason: 'invalid_response' };
   return { kind: 'ok', result: m };
  } catch (e) {
   last = modelFailure(e);
   if (last.kind !== 'transient' || !last.retry || (e instanceof HelperError && e.skipped)) return last; // a breaker answer is final for this run: no retry, no sleep
  }
 }
 return last;
}
/** Does this route want a date (and sender) in the file name even when a rule already chose the route? */
export const wantsNaming = (route: Route, config: Config) => route.rename || (config.naming.datePrefix && DATE_PREFIX_FOLDERS.includes(route.folder));
const now = () => performance.now();
export async function classify(filename: string, text: string, config: Config, deps: ClassifyDeps = {}): Promise<Decision> {
 if (!text.trim()) return review('empty_text');
 const t0 = now(), rule = heuristics(filename, text, config), routeMs = now() - t0;
 if (!rule) {
  const m = await callModel(filename, text, config, deps, null);
  const timing = { routeMs: now() - t0, namingMs: 0, modelCalls: 1 };
  if (m.kind === 'transient') return { ...review(m.reason, true), ...timing };
  if (m.kind === 'failed') return { ...review(m.reason), ...timing };
  if (m.result.needsReview) return { ...review('model_uncertain'), ...timing };
  // Deterministic check of the model's choice: a route with `evidence` (e.g. the model-only admin root) is accepted only when the document itself carries evidence for it.
  const chosen = config.routes.find(r => r.id === m.result.route);
  if (chosen && !routeVerified(chosen, filename, text)) return { ...review(`model_route_unverified:${chosen.id}`), ...timing };
  return { route: m.result.route, tier: 'model', needsReview: false, reason: 'model_suggestion', transient: false, documentDate: m.result.documentDate, sender: m.result.sender, ...timing };
 }
 // A rule hit is instant and final: the route is fixed here. Only the file NAME may still need the model.
 const base: Decision = { route: rule.id, tier: 'rule', needsReview: false, reason: 'rule_match', transient: false, documentDate: null, sender: null, routeMs, namingMs: 0, modelCalls: 0 };
 if (!wantsNaming(rule, config)) return base;
 const t1 = now(), det = extractNaming(text, rule, config);
 const missing = !det.date || (rule.rename && !det.sender);
 const done = (extra: Partial<Decision>): Decision => ({ ...base, documentDate: det.date, sender: det.sender, namingMs: now() - t1, ...extra });
 if (!missing) return done({});
 const m = await callModel(filename, text, config, deps, rule.id); // route locked: the model cannot change it
 if (m.kind === 'transient') return { ...done({ modelCalls: 1 }), transient: true, reason: m.reason };
 // Definite failure (refusal, guardrail, unsupported language, ...): the rule's route stays final and the file keeps its original name; the reason is recorded.
 if (m.kind === 'failed') return done({ modelCalls: 1, namingReason: `naming_${m.reason}` });
 // The model ran. Whatever it could not state stays null and naming.ts keeps the original name.
 const usable = !m.result.needsReview && m.result.route === rule.id;
 return done({ modelCalls: 1, documentDate: det.date ?? (usable ? m.result.documentDate : null), sender: det.sender ?? (usable ? m.result.sender : null) });
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
