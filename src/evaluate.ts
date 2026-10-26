import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { callHelper, type ModelCall, type Tier } from './classifier';
import { type Config } from './config';
import { analyze, type Analysis } from './engine';
import { extract as realExtract } from './extract';
import { INBOX, REVIEW } from './config';

export interface InspectResult { file: string; route: string | null; destination: string | null; tier: Tier; needsReview: boolean; reason: string; renamed: boolean }
const view = (a: Analysis, name: string): InspectResult => ({ file: name, route: a.route?.id ?? null, destination: a.needsReview ? `${INBOX}/${REVIEW}/${name} (review)` : `${a.route!.folder}/${a.name}`, tier: a.tier, needsReview: a.needsReview, reason: a.reason, renamed: a.renamed });
/** `classify <file>`: read-only, any path, no cache/history. */
export async function inspectFile(file: string, config: Config): Promise<InspectResult> {
 const abs = resolve(file), name = abs.split('/').pop()!;
 return view(await analyze(abs, name, null, config), name);
}
export type Labels = Record<string, string>;
export function parseLabels(raw: unknown, config: Config): Labels {
 if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('labels must be a JSON object of filename -> route id | "review"');
 const ids = new Set([...config.routes.map(r => r.id), 'review']);
 for (const [k, v] of Object.entries(raw)) if (typeof v !== 'string' || !ids.has(v)) throw Error(`unknown route "${String(v)}" for "${k}"`);
 return raw as Labels;
}
export interface EvalRow { file: string; expected: string | null; got: string; tier: Tier; reason: string; verdict: 'correct' | 'misrouted' | 'review_instead' | 'auto_instead_of_review' | 'unlabeled'; name: string; renamed: boolean; extractMs: number; classifyMs: number; modelCalls: number }
export interface Stats { n: number; minMs: number | null; medianMs: number | null; p95Ms: number | null; maxMs: number | null }
export interface EvalReport {
 files: number; distribution: Record<string, number>; reviewRate: number; labeled: number;
 accuracy: number | null; correct: number; misrouted: number; reviewInstead: number; autoInsteadOfReview: number;
 latency: { extraction: Stats; ruleTier: Stats; modelTierWarm: Stats; modelColdMs: number | null; modelCallColdMs: number | null; modelCallWarm: Stats };
 rows: EvalRow[];
}
export function stats(xs: number[]): Stats {
 if (!xs.length) return { n: 0, minMs: null, medianMs: null, p95Ms: null, maxMs: null };
 const s = [...xs].sort((a, b) => a - b), at = (q: number) => Math.round(s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]! * 10) / 10;
 return { n: s.length, minMs: at(0), medianMs: at(0.5), p95Ms: at(0.95), maxMs: at(1) };
}
export interface EvalDeps { model?: ModelCall; extract?: (f: string, c: Config) => Promise<string>; now?: () => number }
/** Read-only batch report for Paul's real-document check. Never writes anywhere, never uses the cache. */
export async function evaluate(dir: string, config: Config, labels: Labels | null, deps: EvalDeps = {}, skipFiles: string[] = []): Promise<EvalReport> {
 const now = deps.now ?? (() => performance.now()), root = resolve(dir);
 const names = (await readdir(root, { withFileTypes: true })).filter(e => e.isFile() && !e.name.startsWith('.') && !skipFiles.includes(join(root, e.name))).map(e => e.name).sort().slice(0, 500);
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
  const a = await analyze(file, name, null, config, { extract, model, sleep: async () => {} });
  const total = now() - t0, classifyMs = Math.max(0, total - ex);
  const got = a.needsReview ? 'review' : a.route!.id, expected = labels?.[name] ?? null;
  const verdict: EvalRow['verdict'] = expected === null ? 'unlabeled' : got === expected ? 'correct' : got === 'review' ? 'review_instead' : expected === 'review' ? 'auto_instead_of_review' : 'misrouted';
  if (calls > 0) { if (cold === null) { cold = classifyMs; coldCall = callTotal; } else modelCallMs.push(callTotal); }
  extractMs.push(ex);
  rows.push({ file: name, expected, got, tier: a.tier, reason: a.reason, verdict, name: a.name, renamed: a.renamed, extractMs: Math.round(ex), classifyMs: Math.round(classifyMs), modelCalls: calls });
 }
 const distribution: Record<string, number> = {};
 for (const r of rows) distribution[r.got] = (distribution[r.got] ?? 0) + 1;
 const labeledRows = rows.filter(r => r.verdict !== 'unlabeled'), count = (v: EvalRow['verdict']) => rows.filter(r => r.verdict === v).length;
 return {
  files: rows.length, distribution, reviewRate: rows.length ? (distribution.review ?? 0) / rows.length : 0, labeled: labeledRows.length,
  accuracy: labeledRows.length ? count('correct') / labeledRows.length : null, correct: count('correct'), misrouted: count('misrouted'), reviewInstead: count('review_instead'), autoInsteadOfReview: count('auto_instead_of_review'),
  latency: {
   extraction: stats(extractMs),
   ruleTier: stats(rows.filter(r => r.tier === 'rule' && r.modelCalls === 0).map(r => r.classifyMs)),
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
 if (r.labeled) lines.push(`Accuracy vs labels: ${r.correct}/${r.labeled} (${pct(r.accuracy!)})   wrong auto-route: ${r.misrouted}   auto-routed but expected review: ${r.autoInsteadOfReview}   sent to review instead: ${r.reviewInstead}`);
 lines.push('Latency:', `  extraction (OCR/pdf/text): ${ms(r.latency.extraction)}`, `  rule tier (no model):      ${ms(r.latency.ruleTier)}`, `  model tier cold (1st call): ${r.latency.modelColdMs === null ? 'n/a' : `${r.latency.modelColdMs}ms total, ${r.latency.modelCallColdMs}ms in helper`}`, `  model tier warm:           ${ms(r.latency.modelTierWarm)}`, `  helper call only, warm:    ${ms(r.latency.modelCallWarm)}`, '', 'file | expected | got | tier | reason | proposed name');
 for (const x of r.rows) lines.push(`${x.file} | ${x.expected ?? '-'} | ${x.got}${x.verdict === 'misrouted' || x.verdict === 'auto_instead_of_review' ? ' ✗' : ''} | ${x.tier} | ${x.reason} | ${x.renamed ? x.name : '(keep)'}`);
 return lines.join('\n');
}
