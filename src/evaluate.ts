import { lstat, readdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { callHelper, type ModelCall, type Tier } from './classifier';
import { safeName, type Config } from './config';
import { analyze, type Analysis } from './engine';
import { extract as realExtract } from './extract';
import { helperState } from './process';
import { INBOX, REVIEW } from './config';

export interface InspectResult { file: string; route: string | null; destination: string | null; tier: Tier; needsReview: boolean; reason: string; renamed: boolean; /** Why a file that should be renamed kept its name (naming_*). */ namingReason?: string; /** Tier-1 keywords per route, name vs text (local diagnostics only). */ rules?: string }
const view = (a: Analysis, name: string): InspectResult => ({ file: name, route: a.route?.id ?? null, destination: a.transient ? `${INBOX}/${name} (pending: ${a.reason}, retried later)` : a.needsReview ? `${INBOX}/${REVIEW}/${name} (review)` : `${a.route!.folder}/${a.name}`, tier: a.tier, needsReview: a.needsReview, reason: a.reason, renamed: a.renamed, ...(a.note ? { namingReason: a.note } : {}), ...(a.rules ? { rules: a.rules } : {}) });
/** `classify <file>`: read-only, any path, no cache/history. */
export async function inspectFile(file: string, config: Config): Promise<InspectResult> {
 const abs = resolve(file), name = abs.split('/').pop()!;
 return view(await analyze(abs, name, null, config, { trace: true }), name);
}
export type Labels = Record<string, string>;
export function parseLabels(raw: unknown, config: Config): Labels {
 if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('labels must be a JSON object of filename -> route id | "review"');
 const ids = new Set([...config.routes.map(r => r.id), 'review']);
 const labels: Labels = {};
 for (const [k, v] of Object.entries(raw)) {
  if (typeof v !== 'string' || !ids.has(v)) throw Error(`unknown route "${String(v)}" for "${k}"`);
  // APFS lists file names decomposed (NFD) while a labels file is usually typed/saved composed (NFC): compare in NFC.
  const key = k.normalize('NFC');
  if (Object.hasOwn(labels, key) && labels[key] !== v) throw Error(`conflicting labels for "${key}" (the same name in two Unicode spellings)`);
  Object.defineProperty(labels, key, { value: v, enumerable: true, writable: true, configurable: true });
 }
 return labels;
}
export interface EvalRow { file: string; rules?: string; expected: string | null; got: string; tier: Tier; reason: string; verdict: 'correct' | 'misrouted' | 'review_instead' | 'auto_instead_of_review' | 'unlabeled'; name: string; renamed: boolean; extractMs: number; classifyMs: number; modelCalls: number; routeMs: number; namingMs: number }
export interface Stats { n: number; minMs: number | null; medianMs: number | null; p95Ms: number | null; maxMs: number | null }
export interface EvalReport {
 files: number; /** Set when the folder holds more files than the cap: only `evaluated` of `total` were looked at. */
 capped: { total: number; evaluated: number } | null; distribution: Record<string, number>; reviewRate: number; labeled: number;
 /** Labels whose filename is not in the folder (typos silently shrink the accuracy denominator otherwise). */
 unmatchedLabels: string[];
 /** Helpers that are missing / not executable (only checked for the real ones, not for injected test doubles): one prominent warning each. */
 helperWarnings: string[];
 accuracy: number | null; correct: number; misrouted: number; reviewInstead: number; autoInsteadOfReview: number;
 /** Rule-tier routing = pure heuristics (no model, no extraction). Budget: p95 <= 10 ms; `ruleTierSlow` flags a regression. Naming (deterministic extraction, plus a model call when fields are missing) is reported on its own. */
 latency: { extraction: Stats; ruleTier: Stats; ruleTierSlow: boolean; naming: Stats; modelTierWarm: Stats; modelColdMs: number | null; modelCallColdMs: number | null; modelCallWarm: Stats };
 rows: EvalRow[];
}
export function stats(xs: number[]): Stats {
 if (!xs.length) return { n: 0, minMs: null, medianMs: null, p95Ms: null, maxMs: null };
 const s = [...xs].sort((a, b) => a - b), at = (q: number) => Math.round(s[Math.max(0, Math.min(s.length - 1, Math.ceil(q * s.length) - 1))]! * 10) / 10;
 return { n: s.length, minMs: at(0), medianMs: at(0.5), p95Ms: at(0.95), maxMs: at(1) };
}
export const RULE_TIER_BUDGET_MS = 10, DEFAULT_MAX_FILES = 500;
export const ruleTierSlow = (s: Stats) => s.p95Ms !== null && s.p95Ms > RULE_TIER_BUDGET_MS;
export interface EvalOptions { maxFiles?: number; /** Record the Tier-1 keyword trace per file (printed by `formatReport`). */ verbose?: boolean }
/** Like stats(), but keeps two decimals: rule routing takes well under a millisecond. */
function statsPrecise(xs: number[]): Stats {
 const s = stats(xs.map(x => x * 100)); const d = (v: number | null) => v === null ? null : Math.round(v) / 100;
 return { n: s.n, minMs: d(s.minMs), medianMs: d(s.medianMs), p95Ms: d(s.p95Ms), maxMs: d(s.maxMs) };
}
export interface EvalDeps { model?: ModelCall; extract?: (f: string, c: Config) => Promise<string>; now?: () => number }
/** Read-only batch report for Paul's real-document check. Never writes anywhere, never uses the cache. */
/** One-line explanation for a helper that cannot be started; the fix is always the same. */
export const helperWarning = (what: 'OCR' | 'classifier', path: string, state: string) => `${what} helper ${state === 'missing' ? 'MISSING' : state === 'not_a_file' ? 'is not a file' : 'is NOT EXECUTABLE'} (${path}): ${what === 'OCR' ? 'PDFs and images cannot be read and stay pending' : 'files that need the model stay pending'}. Run: bun run build:helpers`;
export async function evaluate(dir: string, config: Config, labels: Labels | null, deps: EvalDeps = {}, skipFiles: string[] = [], opts: EvalOptions = {}): Promise<EvalReport> {
 const now = deps.now ?? (() => performance.now()), root = resolve(dir);
 const cap = opts.maxFiles ?? DEFAULT_MAX_FILES;
 // Dotfiles (.DS_Store, ...), the labels file (--expected, or the conventional labels.json) and symlinks are not documents.
 const all = (await readdir(root, { withFileTypes: true })).filter(e => e.isFile() && !e.name.startsWith('.') && e.name !== 'labels.json' && !skipFiles.includes(join(root, e.name))).map(e => e.name).sort();
 const names = all.slice(0, cap), capped = all.length > cap ? { total: all.length, evaluated: cap } : null;
 const helperWarnings: string[] = [];
 if (!deps.extract) { const st = await helperState(config.ocr); if (st !== 'ok') helperWarnings.push(helperWarning('OCR', config.ocr, st)); }
 if (!deps.model) { const st = await helperState(config.classifier); if (st !== 'ok') helperWarnings.push(helperWarning('classifier', config.classifier, st)); }
 const rows: EvalRow[] = [], modelCallMs: number[] = [], extractMs: number[] = [];
 let cold: number | null = null, coldCall: number | null = null;
 for (const name of names) {
  const file = join(root, name);
  if ((await lstat(file)).isSymbolicLink()) continue;
  let ex = 0, calls = 0, callTotal = 0;
  const extract = async (f: string, c: Config) => { const t = now(); try { return await (deps.extract ?? realExtract)(f, c); } finally { ex = now() - t; } };
  const inner = deps.model ?? callHelper;
  const model: ModelCall = async (...a) => { const t = now(); calls++; try { return await inner(...a); } finally { callTotal += now() - t; } };
  const t0 = now();
  const a = await analyze(file, name, null, config, { extract, model, sleep: async () => {}, ...(opts.verbose ? { trace: true } : {}) });
  const total = now() - t0, classifyMs = Math.max(0, total - ex);
  const got = a.transient ? 'pending' : a.needsReview ? 'review' : a.route!.id, expected = (labels && Object.hasOwn(labels, name.normalize('NFC')) ? labels[name.normalize('NFC')] : null) ?? null;
  const verdict: EvalRow['verdict'] = expected === null ? 'unlabeled' : got === expected ? 'correct' : got === 'review' || got === 'pending' ? 'review_instead' : expected === 'review' ? 'auto_instead_of_review' : 'misrouted';
  if (calls > 0) { if (cold === null) { cold = classifyMs; coldCall = callTotal; } else modelCallMs.push(callTotal); }
  extractMs.push(ex);
  rows.push({ file: name, ...(a.rules ? { rules: a.rules } : {}), expected, got, tier: a.tier, reason: a.reason, verdict, name: a.name, renamed: a.renamed, extractMs: Math.round(ex), classifyMs: Math.round(classifyMs), modelCalls: calls, routeMs: Math.round((a.routeMs ?? 0) * 100) / 100, namingMs: Math.round((a.namingMs ?? 0) * 10) / 10 });
 }
 const distribution: Record<string, number> = {};
 for (const r of rows) distribution[r.got] = (distribution[r.got] ?? 0) + 1;
 const labeledRows = rows.filter(r => r.verdict !== 'unlabeled'), count = (v: EvalRow['verdict']) => rows.filter(r => r.verdict === v).length;
 const ruleTierStats = statsPrecise(rows.filter(r => r.tier === 'rule').map(r => r.routeMs));
 return {
  files: rows.length, capped, helperWarnings, distribution, unmatchedLabels: labels ? Object.keys(labels).filter(k => !names.some(n => n.normalize('NFC') === k.normalize('NFC'))).sort() : [], reviewRate: rows.length ? (distribution.review ?? 0) / rows.length : 0, labeled: labeledRows.length,
  accuracy: labeledRows.length ? count('correct') / labeledRows.length : null, correct: count('correct'), misrouted: count('misrouted'), reviewInstead: count('review_instead'), autoInsteadOfReview: count('auto_instead_of_review'),
  latency: {
   extraction: stats(extractMs),
   ruleTier: ruleTierStats,
   ruleTierSlow: ruleTierSlow(ruleTierStats),
   naming: stats(rows.filter(r => r.tier === 'rule' && r.namingMs > 0).map(r => r.namingMs)),
   modelTierWarm: stats(rows.filter(r => r.modelCalls > 0).slice(1).map(r => r.classifyMs)),
   modelColdMs: cold === null ? null : Math.round(cold), modelCallColdMs: coldCall === null ? null : Math.round(coldCall), modelCallWarm: stats(modelCallMs)
  },
  rows
 };
}
export async function readLabels(file: string, config: Config): Promise<Labels> { return parseLabels(JSON.parse(await readFile(file, 'utf8')), config); }
export function formatReport(r: EvalReport): string {
 const ms = (s: Stats) => s.n ? `n=${s.n} median ${s.medianMs}ms p95 ${s.p95Ms}ms max ${s.maxMs}ms` : 'n/a';
 const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
 const lines = [`Files: ${r.files}   review rate: ${pct(r.reviewRate)}   routes: ${Object.entries(r.distribution).sort().map(([k, v]) => `${k}=${v}`).join(' ') || '-'}`];
 for (const w of r.helperWarnings) lines.unshift(`⚠⚠ WARNING: ${w}`);
 if (r.capped) lines.push(`WARNING: the folder has ${r.capped.total} files; only the first ${r.capped.evaluated} were evaluated (raise --max-files to see more).`);
 if (r.unmatchedLabels.length) lines.push(`WARNING: ${r.unmatchedLabels.length} label(s) match no file in the folder and are ignored: ${r.unmatchedLabels.join(', ')}`);
 if (r.labeled) lines.push(`Accuracy vs labels: ${r.correct}/${r.labeled} (${pct(r.accuracy!)})   wrong auto-route: ${r.misrouted}   auto-routed but expected review: ${r.autoInsteadOfReview}   sent to review instead: ${r.reviewInstead - pendingLabeled(r)}${pendingLabeled(r) ? `   NOT evaluated (pending: model unavailable, busy or timed out): ${pendingLabeled(r)}` : ''}`);
 lines.push('Latency:', `  extraction (OCR/pdf/text): ${ms(r.latency.extraction)}`, `  rule-tier routing (heuristics only): ${ms(r.latency.ruleTier)}${r.latency.ruleTierSlow ? `   ⚠ p95 above the ${RULE_TIER_BUDGET_MS} ms budget: rule matching should be instant` : `   (budget: p95 ≤ ${RULE_TIER_BUDGET_MS} ms)`}`, `  naming of rule hits (dates/senders; model only if missing): ${ms(r.latency.naming)}`, `  model tier cold (1st call): ${r.latency.modelColdMs === null ? 'n/a' : `${r.latency.modelColdMs}ms total, ${r.latency.modelCallColdMs}ms in helper`}`, `  model tier warm:           ${ms(r.latency.modelTierWarm)}`, `  helper call only, warm:    ${ms(r.latency.modelCallWarm)}`, '', 'file | expected | got | tier | reason | proposed name');
 for (const x of r.rows) { lines.push(`${x.file} | ${x.expected ?? '-'} | ${x.got}${x.verdict === 'misrouted' || x.verdict === 'auto_instead_of_review' ? ' ✗' : ''} | ${x.tier} | ${x.reason} | ${x.renamed ? x.name : '(keep)'}`); if (x.rules) lines.push(`    rules: ${x.rules}`); }
 return lines.join('\n');
}

/**
 * "Unsafe outputs": anything in an eval row that the product must never produce, whatever the document says (prompt injection, hostile text):
 * a route that is not configured, a file name with a path separator / `..` segment / shell or control characters / a changed extension, or a
 * rename that is not the standard `YYYY-MM-DD_Sender-Type.ext` shape. Returns one line per problem (empty = none).
 */
/** Labelled documents that ended pending: they were not evaluated, they are not "sent to review". */
const pendingLabeled = (r: Pick<EvalReport, 'rows'>) => r.rows.filter(x => x.got === 'pending' && x.verdict === 'review_instead').length;
export function unsafeOutputs(rows: Pick<EvalRow, 'file' | 'got' | 'name' | 'renamed'>[], config: Config): string[] {
 const ids = new Set([...config.routes.map(r => r.id), 'review', 'pending']), bad: string[] = [];
 for (const r of rows) {
  if (!ids.has(r.got)) bad.push(`${r.file}: unknown route "${r.got}"`);
  const n = r.name;
  if (!safeName(n) || /[\/\\`$;|<>"'*?\u0000-\u001f\u007f]/.test(n) || n.split(/[\\/]/).includes('..') || n.startsWith('.')) bad.push(`${r.file}: unsafe output name "${n}"`);
  else if (extname(n).toLowerCase() !== extname(r.file).toLowerCase()) bad.push(`${r.file}: output name "${n}" changed the extension`);
  else if (r.renamed && !/^\d{4}-\d{2}-\d{2}_[\p{L}\p{N}][\p{L}\p{N} ._&+-]{0,120}$/u.test(n)) bad.push(`${r.file}: renamed to "${n}", not the standard date_sender shape`);
 }
 return bad;
}
